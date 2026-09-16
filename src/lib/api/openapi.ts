import { toJSONSchema } from "zod";
import {
  agentAuthSchema,
  cartLineSchema,
  catalogItemSchema,
  checkoutRequestSchema,
  checkoutResponseSchema,
  confirmRequestSchema,
  confirmResponseSchema,
  decisionSchema,
  intentMandateSchema,
  negotiateRequestSchema,
  negotiateResponseSchema,
  paymentStatusResponseSchema,
  upsellRequestSchema,
  upsellResponseSchema,
  verifyRequestSchema,
  verifyResponseSchema,
} from "./schemas";

/**
 * Builds the OpenAPI 3.1 document for the public agent-commerce protocol.
 * Schemas are emitted from the Zod wire contracts in `./schemas` — the spec
 * cannot drift from the code: change a schema here, the artifact updates.
 */

function js(schema: unknown): Record<string, unknown> {
  return toJSONSchema(schema as never) as unknown as Record<string, unknown>;
}

const catalogResponse = {
  description: "Matching catalogue items",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { $ref: "#/components/schemas/CatalogItem" },
          },
          nextCursor: { type: "string", nullable: true },
        },
      },
    },
  },
};

const ok = (schemaName: string, description = "Successful response") => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: `#/components/schemas/${schemaName}` },
    },
  },
});

const errorResponse = (
  description: string,
  errorExample = "INTERNAL_SERVER_ERROR",
) => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          error: { type: "string", example: errorExample },
        },
      },
    },
  },
});

function jsonBody(schemaName: string, description = "Request body") {
  return {
    required: true,
    description,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schemaName}` },
      },
    },
  };
}

const agentAuthHeader = {
  description:
    "Agent credential. Demo mode: `x-agent-key: demo`. Strict mode: signed key.",
  schema: { type: "string" },
};

export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "MerchantGate Agent Commerce Protocol",
      version: "1.0.0",
      description:
        "The wire protocol AI buyer agents use to discover a merchant, verify an intent mandate, negotiate bounded pricing, request an authoritative cart mandate, and settle payment. All money values are integers in minor units (INR paise). Prices are always merchant-controlled; agents request quotes, they never set prices.",
    },
    servers: [
      { url: "https://merchantgate.vercel.app", description: "Production" },
      { url: "http://localhost:3000", description: "Local development" },
    ],
    tags: [
      { name: "Discovery" },
      { name: "Catalogue" },
      { name: "Commerce" },
      { name: "Payments" },
    ],
    components: {
      schemas: {
        IntentMandate: js(intentMandateSchema),
        Decision: js(decisionSchema),
        AgentAuth: js(agentAuthSchema),
        CartLine: js(cartLineSchema),
        CatalogItem: js(catalogItemSchema),
        VerifyRequest: js(verifyRequestSchema),
        VerifyResponse: js(verifyResponseSchema),
        NegotiateRequest: js(negotiateRequestSchema),
        NegotiateResponse: js(negotiateResponseSchema),
        CheckoutRequest: js(checkoutRequestSchema),
        CheckoutResponse: js(checkoutResponseSchema),
        ConfirmRequest: js(confirmRequestSchema),
        ConfirmResponse: js(confirmResponseSchema),
        UpsellRequest: js(upsellRequestSchema),
        UpsellResponse: js(upsellResponseSchema),
        PaymentStatusResponse: js(paymentStatusResponseSchema),
      },
      securitySchemes: {
        agentKey: {
          type: "apiKey",
          in: "header",
          name: "x-agent-key",
        },
      },
    },
    security: [{ agentKey: [] }],
    paths: {
      "/.well-known/agent-commerce.json": {
        get: {
          tags: ["Discovery"],
          summary: "Merchant discovery — capabilities, endpoints, currency",
          security: [],
          responses: {
            200: {
              description: "Discovery manifest",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      protocol: {
                        type: "string",
                        example: "agentpay-commerce.v1",
                      },
                      merchantId: { type: "string" },
                      merchantName: { type: "string" },
                      capabilities: { type: "object" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/v1/agent/catalog": {
        get: {
          tags: ["Catalogue"],
          summary: "Search the catalogue with filters + cursor pagination",
          security: [],
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "category", in: "query", schema: { type: "string" } },
            { name: "inStock", in: "query", schema: { type: "string" } },
            { name: "minPrice", in: "query", schema: { type: "integer" } },
            { name: "maxPrice", in: "query", schema: { type: "integer" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: { 200: catalogResponse },
        },
      },
      "/v1/agent/products/{variant_id}": {
        get: {
          tags: ["Catalogue"],
          summary: "Fetch a product variant by id",
          security: [],
          parameters: [
            {
              name: "variant_id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: ok("CatalogItem", "Variant detail"),
            404: errorResponse("Variant not found"),
          },
        },
      },
      "/v1/agent/verify": {
        post: {
          tags: ["Commerce"],
          summary: "Validate agent identity + intent mandate integrity",
          parameters: [
            { name: "x-agent-key", in: "header", ...agentAuthHeader },
          ],
          requestBody: jsonBody("VerifyRequest"),
          responses: {
            200: ok(
              "VerifyResponse",
              "ALLOW / STEP_UP / DENY with reason codes",
            ),
            400: errorResponse("Malformed request", "MISSING_REQUIRED_FIELDS"),
            500: errorResponse("Internal error"),
          },
        },
      },
      "/v1/agent/negotiate": {
        post: {
          tags: ["Commerce"],
          summary:
            "Open/continue/accept a bounded multi-round price negotiation",
          parameters: [
            { name: "x-agent-key", in: "header", ...agentAuthHeader },
          ],
          requestBody: jsonBody("NegotiateRequest"),
          responses: {
            200: ok("NegotiateResponse", "Round outcome + agent guidance"),
            500: errorResponse("Internal error"),
          },
        },
      },
      "/v1/agent/checkout": {
        post: {
          tags: ["Commerce"],
          summary:
            "Request an authoritative, time-bound cart mandate with policy evaluation",
          parameters: [
            { name: "x-agent-key", in: "header", ...agentAuthHeader },
          ],
          requestBody: jsonBody("CheckoutRequest"),
          responses: {
            200: ok(
              "CheckoutResponse",
              "Quote + ALLOW/STEP_UP/DENY evaluation",
            ),
            403: errorResponse("Slippage/security", "CART_SNAPSHOT_MISMATCH"),
            500: errorResponse("Internal error"),
          },
        },
      },
      "/v1/agent/checkout/confirm": {
        post: {
          tags: ["Payments"],
          summary: "Confirm a quote and settle via simulated UAP or Razorpay",
          parameters: [
            { name: "x-agent-key", in: "header", ...agentAuthHeader },
          ],
          requestBody: jsonBody("ConfirmRequest"),
          responses: {
            200: ok("ConfirmResponse", "Settlement / payment_pending order"),
            202: errorResponse(
              "Queued for merchant approval",
              "TRANSACTION_PENDING_MERCHANT_APPROVAL",
            ),
            409: errorResponse(
              "Not authorized for payment",
              "TRANSACTION_NOT_AUTHORIZED",
            ),
            500: errorResponse("Internal error"),
          },
        },
      },
      "/v1/agent/upsell": {
        post: {
          tags: ["Commerce"],
          summary: "Content-addressed cross-sell offers for a basket",
          parameters: [
            { name: "x-agent-key", in: "header", ...agentAuthHeader },
          ],
          requestBody: jsonBody("UpsellRequest"),
          responses: {
            200: ok("UpsellResponse", "Bounded upsell offers"),
            500: errorResponse("Internal error"),
          },
        },
      },
      "/v1/agent/payments/{id}": {
        get: {
          tags: ["Payments"],
          summary: "Check payment status for a payment action",
          security: [],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: ok("PaymentStatusResponse", "Payment lifecycle status"),
            404: errorResponse("Payment not found"),
          },
        },
      },
    },
  };
}
