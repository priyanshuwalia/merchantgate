import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

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
export * from "./schema";
