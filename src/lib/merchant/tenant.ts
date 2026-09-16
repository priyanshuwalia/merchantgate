/**
 * Tenant identity.
 *
 * The platform currently ships with a single demo merchant. Every tenant id in
 * the codebase is sourced from here so multi-tenancy (schema exists:
 * `merchants.api_key_hash`, per-row config) has exactly one constant to retire —
 * never literals scattered through route handlers and lib modules.
 *
 * Depends on nothing: safe to import from any layer without cyclic imports.
 */
export const DEFAULT_MERCHANT_ID = "mch_nimbus_gear_001";
