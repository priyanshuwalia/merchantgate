/**
 * Strict LLM Tool Definitions for Autonomous Buyer Agents
 *
 * SECURITY BOUNDARY:
 * LLM is strictly disallowed from calling any payment execution tools.
 * Allowed tools are limited to: searchCatalog, getProduct, and requestCheckoutProposal.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const AGENT_ALLOWED_TOOLS: ToolDefinition[] = [
  {
    name: "searchCatalog",
    description:
      "Search the merchant catalogue for matching products by keywords, category, and price range.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Keywords to search for in product title, category, and attributes",
        },
        category: {
          type: "string",
          description:
            "Optional category filter (e.g. 'electronics', 'audio', 'accessories', 'computers')",
        },
        minPriceMinor: {
          type: "integer",
          description:
            "Minimum price in minor units (e.g. 100000 for ₹1,000.00)",
        },
        maxPriceMinor: {
          type: "integer",
          description:
            "Maximum price in minor units (e.g. 500000 for ₹5,000.00)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "getProduct",
    description:
      "Retrieve comprehensive specifications, stock inventory, and current pricing for a specific product variant.",
    parameters: {
      type: "object",
      properties: {
        variantId: {
          type: "string",
          description:
            "Unique variant SKU ID of the product (e.g. 'kbd_nimbus_75_black_brown')",
        },
      },
      required: ["variantId"],
    },
  },
  {
    name: "requestCheckoutProposal",
    description:
      "Request an authoritative, time-bound Cart Mandate quote from the merchant API for selected items and delivery constraints.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              variantId: { type: "string" },
              quantity: { type: "integer", minimum: 1 },
              discoveryPriceMinor: { type: "integer" },
            },
            required: ["variantId", "quantity"],
          },
          description: "List of product variants and quantities to purchase",
        },
        intentMandateId: {
          type: "string",
          description:
            "ID of the verified user Intent Mandate authorizing this purchase",
        },
      },
      required: ["items"],
    },
  },
];
