import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration. `schema.ts` is the source of truth; run `bun run db:generate` to emit a
 * migration after changing it, then `bun run db:migrate` to apply.
 *
 * One hand-tuned exception: `request_logs` is range-partitioned (`PARTITION BY start_time`) and
 * `router_settings` carries a seed row. drizzle-kit cannot express either, so the baseline migration
 * (`migrations/0000_init.sql`) is hand-edited to add the partitioning, the default partition, and the
 * seed. The drizzle snapshot still describes `request_logs` as a plain table — which is correct, since
 * drizzle-kit never needs to manage the partitioning on subsequent `generate` runs.
 */
export default defineConfig({
	dialect: "postgresql",
	schema: "./src/db/schema.ts",
	out: "./src/db/migrations",
	dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
