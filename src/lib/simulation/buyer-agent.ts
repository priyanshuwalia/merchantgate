import { generateCanonicalDigest } from "@/lib/crypto/canonical";
import type { IntentMandate } from "@/lib/policy/engine";
import { generateId } from "@/lib/utils";

export class SimulatedBuyerAgent {
  public agentId: string;
  public agentVersion: string;
  public userId: string;
  public intentMandate: IntentMandate;

  constructor(config?: {
    agentId?: string;
    agentVersion?: string;
    userId?: string;
    intentMandate?: Partial<IntentMandate>;
  }) {
    this.agentId = config?.agentId || "agt_apollo_buyer_v1";
    this.agentVersion = config?.agentVersion || "1.0.0";
    this.userId = config?.userId || "user_demo_shopper";

    const mandateId = config?.intentMandate?.id || generateId("int");
    const digest = generateCanonicalDigest({
      mandateId,
      agentId: this.agentId,
      userId: this.userId,
      maxAmount:
        config?.intentMandate?.constraints?.maxTransactionAmountMinor || 500000,
    });

    this.intentMandate = {
      type: "intent_mandate.v1",
      id: mandateId,
      revision: 1,
      principal: { userId: this.userId },
      delegate: { agentId: this.agentId, agentVersion: this.agentVersion },
      instruction:
        config?.intentMandate?.instruction ||
        "Purchase high quality mechanical keyboard under ₹5,000",
      mode: "delegated",
      constraints: {
        currency: "INR",
        maxTransactionAmountMinor: 500000,
        rolling30dAmountMinor: 2000000,
        allowedMerchants: ["mch_nimbus_gear_001"],
        allowedCategories: ["electronics", "audio", "accessories", "computers"],
        quantityMax: 5,
        maxPriceSlippageBps: 200,
        requiresRefundability: true,
        fulfillment: { country: "IND", postalCode: "560001" },
        ...(config?.intentMandate?.constraints || {}),
      },
      validity: {
        notBefore: new Date(Date.now() - 3600000).toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        ...(config?.intentMandate?.validity || {}),
      },
      status: "active",
      devProof: {
        type: "sha256-canonical-json",
        digest,
      },
    };
  }

  async discoverMerchant(baseUrl: string) {
    const res = await fetch(`${baseUrl}/.well-known/agent-commerce.json`);
    return await res.json();
  }

  async searchCatalog(baseUrl: string, query = "") {
    const url = query
      ? `${baseUrl}/v1/agent/catalog?q=${encodeURIComponent(query)}`
      : `${baseUrl}/v1/agent/catalog`;
    const res = await fetch(url);
    return await res.json();
  }

  /**
   * Recompute the devProof digest over the exact mandate payload being
   * presented (devProof itself excluded). Mandate overrides merged into the
   * base mandate change the payload, so the digest must follow the payload or
   * the merchant's cryptographic verification would (correctly) see a tampered
   * proof.
   */
  private withRecomputedProof(mandate: IntentMandate): IntentMandate {
    const { devProof: _omitted, ...payload } = mandate;
    return {
      ...mandate,
      devProof: {
        type: "sha256-canonical-json",
        digest: generateCanonicalDigest(payload),
      },
    };
  }

  async getProduct(baseUrl: string, variantId: string) {
    const res = await fetch(
      `${baseUrl}/v1/agent/products/${encodeURIComponent(variantId)}`,
    );
    return await res.json();
  }

  async verify(baseUrl: string, mandateOverride?: Partial<IntentMandate>) {
    const mandate = this.withRecomputedProof({
      ...this.intentMandate,
      ...(mandateOverride || {}),
    });

    const res = await fetch(`${baseUrl}/v1/agent/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: this.agentId,
        agentVersion: this.agentVersion,
        intentMandate: mandate,
        intentMandateId: mandate.id,
      }),
    });

    return await res.json();
  }

  async checkout(
    baseUrl: string,
    items: Array<{
      variantId: string;
      quantity: number;
      discoveryPriceMinor?: number;
    }>,
    verificationId?: string,
    mandateOverride?: Partial<IntentMandate>,
    negotiationSessionId?: string,
    upsellOfferId?: string,
  ) {
    const mandate = this.withRecomputedProof({
      ...this.intentMandate,
      ...(mandateOverride || {}),
    });

    const res = await fetch(`${baseUrl}/v1/agent/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intentMandateId: mandate.id,
        verificationId: verificationId || generateId("ver"),
        intentMandate: mandate,
        items,
        negotiationSessionId,
        upsellOfferId,
        delivery: {
          country: "IND",
          postalCode: "560001",
          city: "Bengaluru",
          state: "Karnataka",
          addressLine1: "123 Indiranagar 100ft Rd",
        },
      }),
    });

    return await res.json();
  }

  /** Request bounded upsell / cross-sell offers for a cart. */
  async upsell(
    baseUrl: string,
    items: Array<{ variantId: string; quantity: number }>,
  ) {
    const res = await fetch(`${baseUrl}/v1/agent/upsell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: this.agentId, items }),
    });

    return await res.json();
  }

  async negotiate(
    baseUrl: string,
    payload: {
      action: "open" | "respond";
      items?: Array<{ variantId: string; quantity: number }>;
      sessionId?: string;
      targetDiscountBps?: number;
      acceptCurrentOffer?: boolean;
      buyerMessage?: string;
    },
  ) {
    const res = await fetch(`${baseUrl}/v1/agent/negotiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, agentId: this.agentId }),
    });

    return await res.json();
  }

  async confirm(
    baseUrl: string,
    cartMandateId: string,
    decisionId: string,
    paymentMethod = "simulated_uap",
  ) {
    const res = await fetch(`${baseUrl}/v1/agent/checkout/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cartMandateId,
        decisionId,
        paymentMethod,
      }),
    });

    return await res.json();
  }
}
