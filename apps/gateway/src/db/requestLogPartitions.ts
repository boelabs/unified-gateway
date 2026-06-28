import { log } from "#logging/log.ts";
import { env } from "#config/env.ts";
import { sql } from "./client.ts";

interface PartitionRow {
	partitionName: string;
}

const PARTITION_RE = /^request_logs_(\d{4})_(\d{2})_(\d{2})$/;

function dayStartUtc(date: Date): Date {
	return new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
}

function addDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + days);
	return next;
}

function partitionName(day: Date): string {
	const yyyy = String(day.getUTCFullYear()).padStart(4, "0");
	const mm = String(day.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(day.getUTCDate()).padStart(2, "0");
	return `request_logs_${yyyy}_${mm}_${dd}`;
}

function assertSafePartitionName(name: string): void {
	if (!PARTITION_RE.test(name)) {
		throw new Error(`Unsafe request_logs partition name: ${name}`);
	}
}

async function createPartition(day: Date): Promise<void> {
	const name = partitionName(day);
	assertSafePartitionName(name);
	const start = day.toISOString();
	const end = addDays(day, 1).toISOString();
	await sql.unsafe(
		`CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF request_logs FOR VALUES FROM ('${start}') TO ('${end}')`,
	);
}

async function listDailyPartitions(): Promise<PartitionRow[]> {
	return sql<PartitionRow[]>`
    SELECT child.relname AS "partitionName"
    FROM pg_inherits
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    WHERE parent.relname = 'request_logs'
      AND child.relname ~ '^request_logs_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
  `;
}

function partitionDay(name: string): Date | null {
	const match = PARTITION_RE.exec(name);
	if (!match) return null;
	return new Date(
		Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
	);
}

async function dropPartition(name: string): Promise<void> {
	assertSafePartitionName(name);
	await sql.unsafe(`DROP TABLE IF EXISTS "${name}"`);
}

/**
 * Moves any rows sitting in request_logs_default into their proper daily partitions, then re-attaches
 * an empty default. No-op when the default is empty (the common case). Required because rows can land
 * in default before their day's partition exists (e.g. the first requests after a cold start), and
 * once default holds rows in a day's range, creating that day's partition fails — so maintenance
 * drains first. Returns the number of rows moved.
 */
export async function drainDefaultPartition(): Promise<number> {
	const before = await sql<
		{ c: number }[]
	>`SELECT count(*)::int AS c FROM request_logs_default`;
	const total = before[0]?.c ?? 0;
	if (total === 0) return 0;

	await sql.begin(async (tx) => {
		await tx.unsafe(
			`ALTER TABLE request_logs DETACH PARTITION request_logs_default`,
		);
		const days = await tx<{ day: string }[]>`
			SELECT DISTINCT ((start_time AT TIME ZONE 'UTC')::date)::text AS day
			FROM request_logs_default ORDER BY 1
		`;
		for (const { day } of days) {
			const start = dayStartUtc(new Date(`${day}T00:00:00.000Z`));
			const name = partitionName(start);
			assertSafePartitionName(name);
			await tx.unsafe(
				`CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF request_logs FOR VALUES FROM ('${start.toISOString()}') TO ('${addDays(start, 1).toISOString()}')`,
			);
		}
		await tx.unsafe(
			`INSERT INTO request_logs SELECT * FROM request_logs_default`,
		);
		await tx.unsafe(`TRUNCATE request_logs_default`);
		await tx.unsafe(
			`ALTER TABLE request_logs ATTACH PARTITION request_logs_default DEFAULT`,
		);
	});
	return total;
}

async function runPartitionMaintenance(): Promise<void> {
	// Drain first: rows in the default partition for a day's range make that day's partition creation
	// fail, so clear them (no-op when default is empty) before creating today's and the days ahead.
	try {
		const moved = await drainDefaultPartition();
		if (moved > 0)
			log.info("partitions", "drained default into daily partitions", {
				moved,
			});
	} catch (err) {
		log.error("partitions", "draining default partition failed", { err });
	}

	const today = dayStartUtc(new Date());
	// Isolated per day: creating a day's partition can fail if the DEFAULT partition already holds
	// rows in that range (typical for "today", whose rows landed in default before its partition
	// existed). It must not abort creation of the following days.
	for (let i = 0; i <= env.REQUEST_LOG_PARTITION_CREATE_DAYS; i += 1) {
		const day = addDays(today, i);
		try {
			await createPartition(day);
		} catch (err) {
			log.error(
				"partitions",
				`could not create ${partitionName(day)} (likely existing rows in default)`,
				{ err },
			);
		}
	}

	const cutoff = addDays(today, -env.REQUEST_LOG_PARTITION_RETENTION_DAYS);
	for (const row of await listDailyPartitions()) {
		const day = partitionDay(row.partitionName);
		if (day && day < cutoff) {
			await dropPartition(row.partitionName).catch((err: unknown) => {
				log.error("partitions", `drop ${row.partitionName} failed`, { err });
			});
		}
	}
}

// App-chosen advisory-lock key: across replicas, only the one that grabs it runs maintenance this
// cycle (the drain's DETACH/ATTACH is not safe to run concurrently). The lock is session-scoped to the
// reserved connection, so it auto-releases if the connection drops — a crash can never strand it.
const MAINTENANCE_LOCK_KEY = 8_135_472;

async function maintainRequestLogPartitions(): Promise<void> {
	const conn = await sql.reserve();
	try {
		const [row] = await conn<{ locked: boolean }[]>`
			SELECT pg_try_advisory_lock(${MAINTENANCE_LOCK_KEY}) AS locked
		`;
		if (!row?.locked) return; // another replica is maintaining this cycle
		try {
			await runPartitionMaintenance();
		} finally {
			await conn`SELECT pg_advisory_unlock(${MAINTENANCE_LOCK_KEY})`;
		}
	} finally {
		conn.release();
	}
}

export function startRequestLogPartitionJob(): () => void {
	void maintainRequestLogPartitions().catch((err: unknown) => {
		log.error("partitions", "maintenance failed", { err });
	});

	const timer = setInterval(() => {
		void maintainRequestLogPartitions().catch((err: unknown) => {
			log.error("partitions", "maintenance failed", { err });
		});
	}, env.REQUEST_LOG_PARTITION_JOB_INTERVAL_MS);
	timer.unref();

	return () => clearInterval(timer);
}
