// Test bootstrap — MUST be the first import in every unit test. Sets a dummy
// DATABASE_URL so modules that construct the drizzle/neon client at import time
// load without connecting (the client is lazily connected, so nothing is hit).
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://mock:mock@127.0.0.1:5432/mock";
