export const AGENTPAY_BUS_CHANNEL = "agentpay-bus";

export interface ApprovalCheckoutMessage {
  type: "approval_checkout";
  cartMandateId: string;
  paymentActionId: string;
  razorpayOrderId: string;
  razorpayKeyId?: string;
  amountMinor: number;
  currency: string;
  grandTotalMinor: number;
  quantity: number;
  timestamp: string;
}

export type ApprovalCheckoutPayload = Omit<
  ApprovalCheckoutMessage,
  "type" | "timestamp"
>;

/**
 * Publish a just-approved checkout so any open tab (e.g. the Simulation Lab)
 * can surface the Razorpay test checkout immediately. BroadcastChannel only
 * works same-origin across browser tabs — the perfect fit for "approve in the
 * merchant console, pay from the simulator" without polling.
 */
export function publishApprovalCheckout(
  payload: ApprovalCheckoutPayload,
): void {
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return;
  }
  const message: ApprovalCheckoutMessage = {
    ...payload,
    type: "approval_checkout",
    timestamp: new Date().toISOString(),
  };
  try {
    const channel = new BroadcastChannel(AGENTPAY_BUS_CHANNEL);
    channel.postMessage(message);
    channel.close();
  } catch {
    /* non-fatal */
  }
}

/**
 * Subscribe to approval events from any other tab. Returns an unsubscribe
 * function. On the first page load (before any local run) the subscriber is
 * still useful: an approval performed from the console opens the payment UI.
 */
export function subscribeApprovalCheckout(
  handler: (message: ApprovalCheckoutMessage) => void,
): () => void {
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return () => {};
  }
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(AGENTPAY_BUS_CHANNEL);
    channel.onmessage = (event) => {
      const data = event.data as ApprovalCheckoutMessage | undefined;
      if (data?.type === "approval_checkout") handler(data);
    };
  } catch {
    return () => {};
  }
  return () => {
    try {
      channel?.close();
    } catch {
      /* ignore */
    }
  };
}

export interface MerchantControlMessage {
  type: "merchant_control";
  control: "surge";
  active: boolean;
  timestamp: string;
}

/**
 * Publish a merchant console control-tower change (e.g. Surge Pricing toggled
 * from the Overview dashboard) so any other open tab — the Agent Requests
 * monitor, the Simulation Lab — re-fetches without polling.
 */
export function publishMerchantControl(payload: {
  control: "surge";
  active: boolean;
}): void {
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return;
  }
  try {
    const channel = new BroadcastChannel(AGENTPAY_BUS_CHANNEL);
    channel.postMessage({
      ...payload,
      type: "merchant_control",
      timestamp: new Date().toISOString(),
    } satisfies MerchantControlMessage);
    channel.close();
  } catch {
    /* non-fatal */
  }
}

export function subscribeMerchantControl(
  handler: (message: MerchantControlMessage) => void,
): () => void {
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return () => {};
  }
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(AGENTPAY_BUS_CHANNEL);
    channel.onmessage = (event) => {
      const data = event.data as MerchantControlMessage | undefined;
      if (data?.type === "merchant_control") handler(data);
    };
  } catch {
    return () => {};
  }
  return () => {
    try {
      channel?.close();
    } catch {
      /* ignore */
    }
  };
}
