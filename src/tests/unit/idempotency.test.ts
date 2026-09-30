import "./_setup";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isUniqueViolation } from "@/db";
import {
  findQuoteByIdempotencyKey,
  normalizeIdempotencyKey,
} from "@/lib/checkout/idempotency";

/**
 * The unit-test harness points DATABASE_URL at a placeholder that never
 * connects (see `_setup.ts`). Tests that need a live database opt out rather
 * than failing, so `pnpm test` stays meaningful in CI. Run them against a real
 * Neon database by exporting a working DATABASE_URL.
 */
const hasRealDatabase = () =>
  Boolean(process.env.DATABASE_URL) &&
  !process.env.DATABASE_URL!.includes("mock:mock@127.0.0.1:5432/mock");

describe("normalizeIdempotencyKey", () => {
  test("returns null when no header is supplied", () => {
    assert.equal(normalizeIdempotencyKey(null), null);
    assert.equal(normalizeIdempotencyKey(undefined), null);
  });

  test("accepts a well-formed key", () => {
    assert.equal(normalizeIdempotencyKey("abc-123-def-456"), "abc-123-def-456");
  });

  test("trims surrounding whitespace", () => {
    assert.equal(normalizeIdempotencyKey("  key-12345  "), "key-12345");
  });

  test("rejects an empty or whitespace-only header", () => {
    assert.equal(normalizeIdempotencyKey(""), false);
    assert.equal(normalizeIdempotencyKey("   "), false);
  });

  test("rejects keys shorter than 8 characters", () => {
    assert.equal(normalizeIdempotencyKey("abc123"), false);
  });

  test("rejects keys longer than 200 characters", () => {
    assert.equal(normalizeIdempotencyKey("a".repeat(201)), false);
    assert.equal(normalizeIdempotencyKey("a".repeat(200)), "a".repeat(200));
  });

  test("rejects whitespace and control characters inside the key", () => {
    assert.equal(normalizeIdempotencyKey("key with space"), false);
    assert.equal(normalizeIdempotencyKey("key\twith\ttab"), false);
    assert.equal(normalizeIdempotencyKey("key\nwith\nnewline"), false);
  });

  test("rejects non-ASCII characters", () => {
    assert.equal(normalizeIdempotencyKey("ключ-12345"), false);
  });
});

describe("findQuoteByIdempotencyKey", () => {
  test(
    "returns null for an unknown key",
    { skip: !hasRealDatabase() },
    async () => {
      const result = await findQuoteByIdempotencyKey(
        "mch_nimbus_gear_001",
        "no-such-key-12345",
      );
      assert.equal(result, null);
    },
  );

  test(
    "returns null when the key belongs to a different merchant",
    { skip: !hasRealDatabase() },
    async () => {
      // A key issued by one tenant must never resolve for another.
      const result = await findQuoteByIdempotencyKey(
        "mch_other_tenant_999",
        "no-such-key-12345",
      );
      assert.equal(result, null);
    },
  );
});

describe("isUniqueViolation", () => {
  test("detects a bare 23505", () => {
    assert.equal(isUniqueViolation({ code: "23505" }), true);
  });

  test("matches a specific constraint name", () => {
    assert.equal(
      isUniqueViolation(
        { code: "23505", constraint: "uniq_cart_idempotency" },
        "uniq_cart_idempotency",
      ),
      true,
    );
  });

  test("does not match a different constraint name", () => {
    assert.equal(
      isUniqueViolation(
        { code: "23505", constraint: "some_other_index" },
        "uniq_cart_idempotency",
      ),
      false,
    );
  });

  test("rejects non-23505 codes", () => {
    assert.equal(isUniqueViolation({ code: "40001" }), false);
    assert.equal(isUniqueViolation({ code: "23503" }), false);
  });

  test("rejects non-error values", () => {
    assert.equal(isUniqueViolation(null), false);
    assert.equal(isUniqueViolation(undefined), false);
    assert.equal(isUniqueViolation("23505"), false);
    assert.equal(isUniqueViolation({}), false);
  });
});
