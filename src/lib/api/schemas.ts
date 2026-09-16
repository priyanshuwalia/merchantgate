import { z } from "zod";

/**
 * Wire contracts for the public agent-commerce protocol. These are the single
 * source of truth for the API's request/response shapes, mirrored one-to-one in
 * the OpenAPI artifact (`/api/openapi.json`). All money is in minor units.
 */

export const intentMandateSchema = z.object({
  type: z.literal("intent_mandate.v1"),
  id: z.string().optional(),
  principal: z
    .object({
      userId: z.string(),
      displayName: z.string().optional(),
    })
    .optional(),
  constraints: z
    .object({
      maxTransactionAmountMinor: z.number().int().min(0).optional(),
      rolling30dAmountMinor: z.number().int().min(0).optional(),
      currency: z.string().optional(),
    })
    .optional(),
  validity: z
    .object({
      notBefore: z.string().optional(),
      expiresAt: z.string().optional(),
    })
    .optional(),
  devProof: z
    .object({
      digest: z.string().length(64).optional(),
    })
    .optional(),
});

export const decisionSchema = z.enum(["ALLOW", "STEP_UP", "DENY"]);
export type Decision = z.infer<typeof decisionSchema>;

export const agentAuthSchema = z.object({
  mode: z.string(),
  agentId: z.string(),
  rateLimitRemaining: z.number().int().optional(),
});

export const verifyRequestSchema = z.object({
  agentId: z.string(),
  agentVersion: z.string().optional(),
  intentMandate: intentMandateSchema,
  intentMandateId: z.string().optional(),
});

export const verifyResponseSchema = z.object({
  verified: z.boolean(),
  decision: decisionSchema,
  reasonCodes: z.array(z.string()),
  explanation: z.string().optional(),
  verificationId: z.string(),
  expiresAt: z.string(),
  applicableLimits: z.object({
    maxTransactionAmountMinor: z.number().int(),
    rollingBudgetRemainingMinor: z.number().int(),
  }),
  agentAuth: agentAuthSchema.optional(),
});

export const cartLineSchema = z.object({
  variantId: z.string(),
  quantity: z.number().int().min(1).optional(),
  agreedUnitPriceMinor: z.number().int().min(0).optional(),
});

export const negotiateRequestSchema = z.object({
  sessionId: z.string().optional(),
  action: z.enum(["open", "respond", "accept"]).default("open"),
  items: z.array(cartLineSchema).max(25).optional(),
  buyerMessage: z.string().optional(),
  counterPriceMinor: z.number().int().min(0).optional(),
});

export const negotiateResponseSchema = z.object({
  success: z.boolean(),
  sessionId: z.string(),
  outcome: z.string(),
  round: z.number().int(),
  roundsRemaining: z.number().int(),
  discountBps: z.number().int(),
  listUnitAmountMinor: z.number().int(),
  agreedUnitAmountMinor: z.number().int(),
  lineSavingsMinor: z.number().int(),
  requiresMerchantApproval: z.boolean(),
  merchantMessage: z.string().optional(),
  buyerGuidance: z.string().optional(),
  reasonCodes: z.array(z.string()),
  status: z.string(),
  transcript: z.array(z.unknown()).optional(),
});

export const checkoutRequestSchema = z.object({
  intentMandateId: z.string(),
  verificationId: z.string().optional(),
  items: z.array(cartLineSchema).min(1).max(25),
  upsellOfferId: z.string().optional(),
  agentId: z.string().optional(),
});

export const checkoutResponseSchema = z.object({
  success: z.boolean(),
  cartMandate: z.object({
    type: z.literal("cart_mandate.v1"),
    id: z.string().optional(),
    totals: z.object({
      subtotalMinor: z.number().int(),
      campaignDiscountMinor: z.number().int(),
      negotiatedDiscountMinor: z.number().int(),
      grandTotalMinor: z.number().int(),
      currency: z.string(),
    }),
    contentHash: z.string(),
    expiresAt: z.string(),
  }),
  policyEvaluation: z.object({
    decision: decisionSchema,
    reasonCodes: z.array(z.string()),
    verified: z.boolean().optional(),
  }),
  paymentRequired: z.boolean(),
  queuedForApproval: z.boolean(),
  paymentActionId: z.string().optional(),
  razorpayOrderId: z.string().optional(),
  razorpayKeyId: z.string().optional(),
  surgeActive: z.boolean(),
  campaignsApplied: z.array(z.unknown()).optional(),
  upsell: z.unknown().optional(),
  rollingBudgetUsageMinor: z.number().int().optional(),
  rollingBudgetRemainingMinor: z.number().int().optional(),
  agentAuth: agentAuthSchema.optional(),
});

export const confirmRequestSchema = z.object({
  cartMandateId: z.string(),
  decisionId: z.string().optional(),
  paymentMethod: z
    .enum(["simulated_uap", "razorpay_checkout"])
    .default("simulated_uap"),
});

export const confirmResponseSchema = z.object({
  success: z.boolean(),
  paymentActionId: z.string(),
  status: z.string(),
  razorpayOrderId: z.string(),
  razorpayKeyId: z.string().optional(),
  amountMinor: z.number().int(),
  currency: z.string(),
  completedAt: z.string().optional(),
  expiresAt: z.string().optional(),
});

export const upsellRequestSchema = z.object({
  items: z.array(cartLineSchema).min(1).optional(),
  cartSubtotalMinor: z.number().int().min(0).optional(),
  agentId: z.string().optional(),
});

export const upsellResponseSchema = z.object({
  success: z.boolean(),
  offers: z.array(
    z.object({
      offerId: z.string(),
      variantIds: z.array(z.string()),
      discountBps: z.number().int(),
      stackable: z.boolean().optional(),
      message: z.string().optional(),
      accept: z.object({
        checkoutField: z.literal("upsellOfferId"),
        value: z.string(),
      }),
    }),
  ),
  cartSubtotalMinor: z.number().int(),
  maxBasketUpliftMinor: z.number().int(),
  totalUpliftMinor: z.number().int(),
  reasonCodes: z.array(z.string()),
  agentAuthMode: z.string().optional(),
  rateLimit: z
    .object({
      remaining: z.number().int(),
      limit: z.number().int(),
    })
    .optional(),
});

export const catalogItemSchema = z.object({
  productId: z.string(),
  variantId: z.string(),
  merchantId: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  discoveryPrice: z.object({
    amountMinor: z.number().int(),
    currency: z.string(),
  }),
  availability: z.object({
    status: z.enum(["in_stock", "limited", "out_of_stock"]),
    quantityBand: z.string(),
  }),
  returnable: z.boolean(),
  returnWindowDays: z.number().int(),
  version: z.string(),
  updatedAt: z.string(),
});

export const paymentStatusResponseSchema = z.object({
  success: z.boolean(),
  paymentActionId: z.string(),
  status: z.string(),
  decision: decisionSchema.optional(),
  amountMinor: z.number().int().optional(),
  currency: z.string().optional(),
  razorpayPaymentId: z.string().optional(),
  expiresAt: z.string().optional(),
});
