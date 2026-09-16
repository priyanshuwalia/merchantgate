import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

// Security: the database connection string must come from the environment. It
// is NEVER hardcoded in source. If it is missing we fail fast rather than
// silently connect to an exposed/bundled database.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Add a valid Neon PostgreSQL connection string to your environment before starting the app.",
  );
}

const sql = neon(connectionString);

export const db = drizzle({ client: sql });

export interface DbStatement {
  sql: string;
  params: unknown[];
}

export interface RunTransactionOptions {
  /**
   * Postgres isolation level for the batch. `serializable` (default) allows the
   * runtime to abort one side of a concurrent read/write conflict with SQLSTATE
   * 40001 so callers can retry — required for airtight rolling-budget ceiling
   * enforcement when two checkouts race for the same mandate.
   */
  isolationLevel?:
    | "ReadUncommitted"
    | "ReadCommitted"
    | "RepeatableRead"
    | "Serializable";
}

/**
 * Is the error a Postgres serialization failure (SQLSTATE 40001)? Retryable.
 */
export function isSerializationConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "40001"
  );
}

/**
 * Compile a drizzle builder (insert/update/…, including `.onConflictDoNothing()`
 * and SQL fragments) into a plain statement the batch helper can execute.
 *
 * Composite params (objects/arrays) are JSON-serialized here because the raw
 * Neon HTTP query function receives params as text — every composite column in
 * these write paths is `jsonb`, so this is safe. Scalars (numbers, strings,
 * booleans, `Date`, `null`) pass through untouched.
 */
export function toStatement(builder: {
  toSQL: () => { sql: string; params: unknown[] };
}): DbStatement {
  const { sql: statement, params } = builder.toSQL();
  return {
    sql: statement,
    params: params.map((p) =>
      p !== null && typeof p === "object" && !(p instanceof Date)
        ? JSON.stringify(p)
        : p,
    ),
  };
}

/**
 * Execute a set of writes as ONE atomic Postgres transaction over a single
 * HTTP request (Neon http `sql.transaction`, rollback-on-failure).
 *
 * The drizzle neon-http driver does not support interactive `db.transaction()`
 * (it throws at runtime), so the checkout/confirm write paths compile their
 * drizzle builders to statements and commit them through here — getting both
 * atomicity AND a single round-trip instead of one network call per statement.
 */
export async function runTransaction(
  statements: DbStatement[],
  options: RunTransactionOptions = {},
): Promise<void> {
  if (statements.length === 0) return;
  await sql.transaction(
    (txn) =>
      statements.map((s) =>
        txn.query(
          s.sql,
          s.params.map((p) => (p instanceof Date ? p.toISOString() : p)),
        ),
      ),
    { isolationLevel: options.isolationLevel ?? "Serializable" },
  );
}
export * from "./schema";
