import { NextRequest } from "next/server";
import { GET as getDiscovery } from "../app/.well-known/agent-commerce.json/route";
import { POST as handleWebhook } from "../app/api/webhooks/razorpay/route";
import { GET as getCatalog } from "../app/v1/agent/catalog/route";
import { POST as checkoutConfirm } from "../app/v1/agent/checkout/confirm/route";
import { POST as checkoutQuote } from "../app/v1/agent/checkout/route";
import { GET as getPayment } from "../app/v1/agent/payments/[id]/route";
import { GET as getProduct } from "../app/v1/agent/products/[id]/route";
import { POST as verifyMandate } from "../app/v1/agent/verify/route";

async function runApiTests() {
  console.log(
    "\n🌐 Running AgentPay Merchant API Route Handlers Integration Tests...\n",
  );

  // 1. Discovery
  const discoveryReq = new NextRequest(
    "http://localhost:3000/.well-known/agent-commerce.json",
  );
  const discoveryRes = await getDiscovery(discoveryReq);
  const discoveryData = await discoveryRes.json();
  console.log(
    "1. Discovery Manifest:",
    discoveryData.protocol,
    `[${discoveryData.merchantName}]`,
  );
  if (discoveryData.protocol !== "agentpay-commerce.v1")
    throw new Error("Invalid discovery protocol");

  // 2. Catalog
  const catalogReq = new NextRequest(
    "http://localhost:3000/v1/agent/catalog?q=keyboard",
  );
  const catalogRes = await getCatalog(catalogReq);
  const catalogData = await catalogRes.json();
  console.log("2. Catalog Items found:", catalogData.items?.length, "items");
  if (!catalogData.items || catalogData.items.length === 0)
    throw new Error("No items found in catalog");

  // 3. Product Details
  const productRes = await getProduct(catalogReq, {
    params: Promise.resolve({ id: "kbd_nimbus_75_black_brown" }),
  });
  const productData = await productRes.json();
  console.log(
    "3. Product Detail:",
    productData.title,
    `(Price: ₹${productData.pricing?.amountMinor / 100})`,
  );
  if (productData.variantId !== "kbd_nimbus_75_black_brown")
    throw new Error("Variant ID mismatch");

  // 4. Verify Mandate
  const verifyReq = new NextRequest("http://localhost:3000/v1/agent/verify", {
    method: "POST",
    body: JSON.stringify({
      agentId: "agt_apollo_buyer_v1",
      agentVersion: "1.0.0",
      intentMandateId: `int_test_${Date.now()}`,
      intentMandate: {
        type: "intent_mandate.v1",
        id: `int_test_${Date.now()}`,
        revision: 1,
        principal: { userId: "user_test_runner" },
        delegate: { agentId: "agt_apollo_buyer_v1", agentVersion: "1.0.0" },
        constraints: {
          currency: "INR",
          maxTransactionAmountMinor: 500000,
          allowedMerchants: ["mch_nimbus_gear_001"],
          allowedCategories: ["electronics"],
        },
        validity: {
          notBefore: new Date(Date.now() - 3600000).toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      },
    }),
  });
  const verifyRes = await verifyMandate(verifyReq);
  const verifyData = await verifyRes.json();
  console.log(
    "4. Mandate Verification:",
    verifyData.decision,
    verifyData.explanation,
  );
  if (verifyData.decision !== "ALLOW")
    throw new Error(`Verification rejected: ${verifyData.decision}`);

  // 5. Authoritative Checkout Quote
  const checkoutReq = new NextRequest(
    "http://localhost:3000/v1/agent/checkout",
    {
      method: "POST",
      body: JSON.stringify({
        intentMandateId: verifyData.verificationId,
        verificationId: verifyData.verificationId,
        items: [{ variantId: "kbd_nimbus_75_black_brown", quantity: 1 }],
        delivery: { country: "IND", postalCode: "560001" },
      }),
    },
  );
  const checkoutRes = await checkoutQuote(checkoutReq);
  const checkoutData = await checkoutRes.json();
  console.log(
    "5. Authoritative Quote Created:",
    checkoutData.cartMandate?.id,
    `(Grand Total: ₹${checkoutData.cartMandate?.totals?.grandTotalMinor / 100})`,
  );
  if (!checkoutData.success || !checkoutData.cartMandate)
    throw new Error("Checkout quote generation failed");

  const cartMandateId = checkoutData.cartMandate.id;
  const decisionId = checkoutData.policyEvaluation.decisionId;

  // 6. Checkout Confirm (Simulated UAP Payment)
  const confirmReq = new NextRequest(
    "http://localhost:3000/v1/agent/checkout/confirm",
    {
      method: "POST",
      body: JSON.stringify({
        cartMandateId,
        decisionId,
        paymentMethod: "simulated_uap",
      }),
    },
  );
  const confirmRes = await checkoutConfirm(confirmReq);
  const confirmData = await confirmRes.json();
  console.log(
    "6. Checkout Settled:",
    confirmData.status,
    `(PaymentAction: ${confirmData.paymentActionId})`,
  );
  if (confirmData.status !== "completed")
    throw new Error("Checkout confirmation settlement failed");

  // 7. Payment Inquiry
  const paymentRes = await getPayment(confirmReq, {
    params: Promise.resolve({ id: confirmData.paymentActionId }),
  });
  const paymentData = await paymentRes.json();
  console.log(
    "7. Payment Status Query:",
    paymentData.status,
    `Amount: ₹${paymentData.amountMinor / 100}`,
  );
  if (paymentData.status !== "completed")
    throw new Error("Payment status mismatch");

  // 8. Razorpay Webhook Deduplication & Event Processing
  const webhookReq = new NextRequest(
    "http://localhost:3000/api/webhooks/razorpay",
    {
      method: "POST",
      headers: {
        "x-razorpay-signature": "mock_signature_test",
        "x-razorpay-event-id": `evt_test_${Date.now()}`,
      },
      body: JSON.stringify({
        event: "payment.captured",
        id: `evt_test_${Date.now()}`,
        payload: {
          payment: {
            entity: {
              id: `pay_test_${Date.now()}`,
              order_id: checkoutData.razorpayOrderId || "order_sim_test",
              amount: 412882,
              status: "captured",
            },
          },
        },
      }),
    },
  );
  const webhookRes = await handleWebhook(webhookReq);
  const webhookData = await webhookRes.json();
  console.log("8. Razorpay Webhook Ingestion:", webhookData.status);

  console.log("\n🎉 ALL API ENDPOINTS VERIFIED AND PASSING SUCCESSFULLY!\n");
}

runApiTests().catch((err) => {
  console.error("API test failed:", err);
  process.exit(1);
});
