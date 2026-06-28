import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, db } from "./client.ts";
import { join } from "node:path";

/**
 * Applies pending Drizzle migrations from ./migrations, tracked by Drizzle's own metadata table
 * (`drizzle.__drizzle_migrations`). Idempotent: re-running only applies what is pending. Migrations
 * are generated from `schema.ts` with `bun run db:generate` — see `drizzle.config.ts`. The baseline
 * `0000_init.sql` is hand-tuned for `request_logs` partitioning and the `router_settings` seed.
 */
const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

async function run(): Promise<void> {
	await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
	console.log("[migrate] done (up to date)");
}

run()
	.then(() => closeDb())
	.then(() => process.exit(0))
	.catch(async (err) => {
		console.error(
			"[migrate] FAILED:",
			err instanceof Error ? err.message : err,
		);
		await closeDb().catch(() => {});
		process.exit(1);
	});
