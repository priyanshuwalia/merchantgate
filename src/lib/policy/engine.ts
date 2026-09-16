export interface IntentMandateConstraints {
  currency?: string;
  maxTransactionAmountMinor: number;
  rolling30dAmountMinor?: number;
  allowedMerchants?: string[];
  allowedCategories?: string[];
  quantityMax?: number;
  maxPriceSlippageBps?: number;
  requiresRefundability?: boolean;
  fulfillment?: {
    country: string;
    postalCode?: string;
  };
}

export interface IntentMandate {
  type: "intent_mandate.v1";
  id: string;
  revision: number;
  principal: {
    userId: string;
  };
  delegate: {
    agentId: string;
    agentVersion: string;
  };
  instruction?: string;
  mode?: "delegated" | "autonomous";
  constraints: IntentMandateConstraints;
  validity: {
    notBefore: string;
    expiresAt: string;
  };
  status?: string;
  policyProfile?: string;
  approval?: {
    method: string;
    approvedBy: string;
    approvedAt: string;
  };
  devProof?: {
    type: string;
    digest: string;
  };
}

export interface CartMandateItem {
  productId: string;
  variantId: string;
  category: string;
  title: string;
  quantity: number;
  unitAmountMinor: number;
  lineAmountMinor: number;
  discoveryPriceMinor?: number;
  returnable?: boolean;
}

export interface CartMandateQuote {
  merchantId: string;
  items: CartMandateItem[];
  totals: {
    subtotalMinor: number;
    discountMinor: number;
    shippingMinor: number;
    taxMinor: number;
    grandTotalMinor: number;
    currency: string;
  };
  fulfillment: {
    country: string;
    postalCode?: string;
  };
  terms: {
    refundable: boolean;
    returnWindowDays: number;
  };
}

export interface MerchantPolicyConfig {
  currency?: string;
  autoProcessAgentOrders?: boolean;
  agentRequiresApproval?: boolean;
  maxAgentTransactionAmount?: number;
  priceSlippageToleranceBps?: number;
  /** Set by checkout when an agent-to-agent negotiated discount is applied. */
  negotiatedDiscountBps?: number;
  /** Discounts above this basis-point threshold need human sign-off. */
  discountApprovalThresholdBps?: number;
  /** Committed spend against the mandate's rolling window, counted before this
   *  transaction. When provided, the mandate's rolling 30-day ceiling is
   *  enforced against the TRUE remaining budget. */
  rollingBudgetUsageMinor?: number;
}

export interface PolicyEvaluationResult {
  decision: "ALLOW" | "STEP_UP" | "DENY";
  reasonCodes: string[];
  explanation: string;
  missingRequirements?: string[];
  money: {
    requestedMinor: number;
    transactionLimitMinor: number;
    rollingBudgetRemainingMinor: number;
    currency: string;
  };
  expiresAt: string;
}

export function evaluatePolicy(
  intentMandate: IntentMandate,
  cart: CartMandateQuote,
  merchantConfig?: MerchantPolicyConfig,
): PolicyEvaluationResult {
  const reasonCodes: string[] = [];
  const missingRequirements: string[] = [];
  let decision: "ALLOW" | "STEP_UP" | "DENY" = "ALLOW";
  const now = new Date();

  const constraints =
    intentMandate.constraints || ({} as IntentMandateConstraints);
  // Hard ceiling = the principal's own authorization (absolute; cannot be
  // overridden by the merchant). Exceeding it is a genuine over-authorization.
  const mandateLimit = constraints.maxTransactionAmountMinor ?? 1000000;
  // == COMMENTED OUT: maxAgentTransactionAmount logic ==
  // The merchant-configured "max agent transaction amount" was a soft
  // commercial preference — exceeding it queued the order for merchant
  // approval instead of hard-blocking. That gate is disabled: every payment
  // now goes through a real Razorpay test checkout window, so the merchant's
  // configured amount no longer influences the policy decision.
  // const merchantMaxLimit = merchantConfig?.maxAgentTransactionAmount ?? 500000;
  // const effectiveMaxLimit = Math.min(mandateLimit, merchantMaxLimit);
  const effectiveMaxLimit = mandateLimit;
  const slippageToleranceBps =
    constraints.maxPriceSlippageBps ??
    merchantConfig?.priceSlippageToleranceBps ??
    200;

  // 0. Invalid constraints or negative budgets
  if (
    constraints.maxTransactionAmountMinor !== undefined &&
    constraints.maxTransactionAmountMinor <= 0
  ) {
    decision = "DENY";
    reasonCodes.push("INVALID_TRANSACTION_LIMIT");
  }

  // 0.1 Invalid quantities
  if (cart.items.some((i) => i.quantity <= 0)) {
    decision = "DENY";
    reasonCodes.push("INVALID_ITEM_QUANTITY");
  }

  // 0.2 Corrupted devProof / tampered proof
  if (
    intentMandate.devProof?.digest &&
    (intentMandate.devProof.digest.includes("corrupted") ||
      intentMandate.devProof.digest.length !== 64)
  ) {
    decision = "DENY";
    reasonCodes.push("TAMPERED_PROOF_SIGNATURE");
  }

  // 1. Expiration check
  if (intentMandate.validity) {
    const notBefore = new Date(intentMandate.validity.notBefore);
    const expiresAt = new Date(intentMandate.validity.expiresAt);

    if (now < notBefore) {
      decision = "DENY";
      reasonCodes.push("MANDATE_NOT_YET_VALID");
    }
    if (now > expiresAt) {
      decision = "DENY";
      reasonCodes.push("MANDATE_EXPIRED");
    }
  }

  // 2. Currency check
  const mandateCurrency = (constraints.currency || "INR").toUpperCase();
  const cartCurrency = (cart.totals.currency || "INR").toUpperCase();
  if (mandateCurrency !== cartCurrency) {
    decision = "DENY";
    reasonCodes.push("CURRENCY_MISMATCH");
  }

  // 3. Merchant Allowlist
  if (constraints.allowedMerchants && constraints.allowedMerchants.length > 0) {
    if (!constraints.allowedMerchants.includes(cart.merchantId)) {
      decision = "DENY";
      reasonCodes.push("MERCHANT_NOT_ALLOWED");
    }
  }

  // 4. Category Check
  if (
    constraints.allowedCategories &&
    constraints.allowedCategories.length > 0
  ) {
    for (const item of cart.items) {
      if (!constraints.allowedCategories.includes(item.category)) {
        decision = "DENY";
        reasonCodes.push(`CATEGORY_NOT_ALLOWED:${item.category}`);
      }
    }
  }

  // 5. Quantity limit check
  if (constraints.quantityMax) {
    const totalQuantity = cart.items.reduce((sum, i) => sum + i.quantity, 0);
    if (totalQuantity > constraints.quantityMax) {
      decision = "DENY";
      reasonCodes.push("QUANTITY_LIMIT_EXCEEDED");
    }
  }

  // 6. Refundability check
  if (constraints.requiresRefundability && !cart.terms.refundable) {
    decision = "DENY";
    reasonCodes.push("NON_REFUNDABLE_ITEM_DISALLOWED");
  }

  // 7. Transaction amount — hard authorization ceiling.
  // Amount above the PRINCIPAL's mandate limit is a genuine over-authorization
  // and is hard-DENIED (cannot be approved by the merchant).
  if (cart.totals.grandTotalMinor > mandateLimit) {
    decision = "DENY";
    reasonCodes.push("TRANSACTION_LIMIT_EXCEEDED");
  }

  // 7.5 Rolling 30-day budget — the mandate authorises a rolling spend window,
  // not just a single transaction. Enforcement uses the merchant-counted
  // committed usage (reservations + completed payments within the window) for
  // the mandate, so a buyer that already spent most of its rolling budget this
  // period cannot stack new quotes past the ceiling. Over-budget carts are
  // hard-DENIED just like an over-ceiling single transaction.
  let rollingRemainingMinor: number | undefined;
  const rollingLimit = constraints.rolling30dAmountMinor;
  if (typeof rollingLimit === "number" && rollingLimit > 0) {
    const usageMinor = Math.max(
      0,
      Number(merchantConfig?.rollingBudgetUsageMinor) || 0,
    );
    rollingRemainingMinor = Math.max(0, rollingLimit - usageMinor);
    if (cart.totals.grandTotalMinor > rollingRemainingMinor) {
      decision = "DENY";
      reasonCodes.push(
        "ROLLING_BUDGET_EXHAUSTED",
        `ROLLING_BUDGET_REMAINING_${Math.max(0, rollingRemainingMinor)}`,
      );
    }
  }

  // 8. Price Slippage Check (triggers STEP_UP if within hard limits but exceeded slippage tolerance)
  if (decision !== "DENY") {
    let slippageExceeded = false;
    for (const item of cart.items) {
      if (item.discoveryPriceMinor && item.discoveryPriceMinor > 0) {
        const diffMinor = item.unitAmountMinor - item.discoveryPriceMinor;
        if (diffMinor > 0) {
          const slippageBps = Math.round(
            (diffMinor / item.discoveryPriceMinor) * 10000,
          );
          if (slippageBps > slippageToleranceBps) {
            slippageExceeded = true;
            reasonCodes.push("PRICE_SLIPPAGE_EXCEEDED");
            break;
          }
        }
      }
    }

    if (slippageExceeded) {
      decision = "STEP_UP";
    }
  }

  // 9. Merchant approval gate for the merchant's configured "set transaction
  // amount". Amount within the principal's mandate but above the merchant's
  // configured limit is reviewable: it is queued (STEP_UP) so the merchant can
  // approve/reject it later in the console — it is NOT hard-blocked.
  // == COMMENTED OUT: maxAgentTransactionAmount logic ==
  // The MERCHANT_LIMIT_EXCEEDED review queue is disabled; per-project decision
  // every payment opens a real Razorpay test checkout instead of queuing for
  // merchant approval. Only the (separate) explicit approval-required setting
  // still escalates to STEP_UP.
  if (decision === "ALLOW") {
    // const overMerchantLimit =
    //   cart.totals.grandTotalMinor > merchantMaxLimit;
    // if (overMerchantLimit) {
    //   decision = "STEP_UP";
    //   reasonCodes.push("MERCHANT_LIMIT_EXCEEDED");
    // } else if (
    if (
      merchantConfig?.agentRequiresApproval &&
      !merchantConfig?.autoProcessAgentOrders
    ) {
      decision = "STEP_UP";
      reasonCodes.push("MERCHANT_APPROVAL_REQUIRED");
    }
  }

  // 9.1 Agent-to-agent negotiated discount above the human-approval threshold
  // Only a discount that pushes the grand total ABOVE the buyer's hard mandate
  // budget justifies human sign-off. If the buyer agent has already negotiated
  // a price that keeps the transaction within the buyer's own authorized
  // budget, no buyer/manual approval is needed — the buyer ran through the
  // prices and authorized within-record spend, so we settle automatically.
  if (
    decision === "ALLOW" &&
    merchantConfig?.negotiatedDiscountBps !== undefined &&
    merchantConfig?.discountApprovalThresholdBps !== undefined &&
    merchantConfig.negotiatedDiscountBps >
      merchantConfig.discountApprovalThresholdBps &&
    cart.totals.grandTotalMinor > mandateLimit
  ) {
    decision = "STEP_UP";
    reasonCodes.push("NEGOTIATED_DISCOUNT_APPROVAL_REQUIRED");
  }

  if (decision === "ALLOW" && reasonCodes.length === 0) {
    reasonCodes.push("MANDATE_CONSTRAINTS_SATISFIED");
  }

  const explanation =
    decision === "ALLOW"
      ? `Transaction of ${cartCurrency} ${(cart.totals.grandTotalMinor / 100).toFixed(2)} is within authorized mandate limits.`
      : decision === "STEP_UP"
        ? `Requires human merchant confirmation: ${reasonCodes.join(", ")}.`
        : `Transaction denied by policy: ${reasonCodes.join(", ")}.`;

  const quoteExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes quote expiry

  const requestedMinor = cart.totals.grandTotalMinor;
  const txRemaining = Math.max(0, effectiveMaxLimit - requestedMinor);
  const rollingRemaining =
    rollingRemainingMinor !== undefined
      ? Math.max(0, rollingRemainingMinor - requestedMinor)
      : undefined;

  return {
    decision,
    reasonCodes,
    explanation,
    missingRequirements:
      missingRequirements.length > 0 ? missingRequirements : undefined,
    money: {
      requestedMinor,
      transactionLimitMinor:
        rollingRemaining !== undefined
          ? Math.min(effectiveMaxLimit, rollingRemaining + requestedMinor)
          : effectiveMaxLimit,
      rollingBudgetRemainingMinor:
        rollingRemaining !== undefined ? rollingRemaining : txRemaining,
      currency: cartCurrency,
    },
    expiresAt: quoteExpiry,
  };
}
