/** Deterministic unit-test environment; never depend on a developer's ignored .env file. */
process.env.NODE_ENV = "test";
process.env.MASTER_KEY = "unit-test-master-key";
process.env.CREDENTIALS_ENCRYPTION_KEY = "0".repeat(64);
process.env.DATABASE_URL =
	"postgres://gateway:gateway@localhost:5432/unifiedgateway_test";
process.env.REDIS_URL = "redis://localhost:6379/15";

await import("./noRealFetch.ts");

export {};
