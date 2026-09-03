"use client";

import {
  CheckCircle2,
  Clock,
  CreditCard,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Header } from "@/components/dashboard/Header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatMinorUnits } from "@/lib/utils";

declare global {
  interface Window {
    Razorpay?: any;
  }
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<any>(null);
  const [refundReason, setRefundReason] = useState("");
  const [processing, setProcessing] = useState(false);
  const [payingOrderId, setPayingOrderId] = useState<string | null>(null);

  const fetchOrders = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/merchant/stats");
      if (!res.ok) throw new Error(`Orders request failed: ${res.status}`);
      const data = await res.json();
      if (data.recentOrders) {
        setOrders(data.recentOrders);
      }
    } catch (e) {
      console.error(e);
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, []);

  const loadRazorpayScript = () => {
    return new Promise((resolve) => {
      if (window.Razorpay) {
        return resolve(true);
      }
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  };

  const handlePayWithRazorpay = async (ord: any) => {
    try {
      setPayingOrderId(ord.id);
      const scriptLoaded = await loadRazorpayScript();
      if (!scriptLoaded) {
        alert(
          "Failed to load Razorpay SDK. Please check your internet connection.",
        );
        return;
      }

      const keyId =
        process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || "rzp_test_TU08LEvLxjUmy3";

      const options = {
        key: keyId,
        amount: ord.amount_minor,
        currency: ord.currency || "INR",
        name: "AgentPay Merchant",
        description: `Order for Cart Mandate: ${ord.cart_mandate_id}`,
        order_id: ord.razorpay_order_id,
        handler: async (response: any) => {
          console.log("[Razorpay Client] Payment success response:", response);
          // The server cryptographically verifies the payment signature before
          // marking the order settled — the browser never confirms a payment.
          const verifyRes = await fetch("/api/merchant/payments/verify", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-merchant-csrf": "1",
            },
            body: JSON.stringify({
              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
            }),
          });
          if (!verifyRes.ok) {
            console.error(
              "Payment verification rejected:",
              await verifyRes.text(),
            );
          }
          fetchOrders();
        },
        prefill: {
          name: "AI Buyer Delegate",
          email: "agent@agentpay.dev",
          contact: "9999999999",
        },
        theme: {
          color: "#0066ff",
        },
      };

      const paymentObject = new window.Razorpay(options);
      paymentObject.open();
    } catch (err) {
      console.error("Razorpay popup error:", err);
    } finally {
      setPayingOrderId(null);
    }
  };

  const handleRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;
    try {
      setProcessing(true);
      const res = await fetch(
        `/api/merchant/orders/${selectedOrder.id}/refund`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: refundReason }),
        },
      );
      if (res.ok) {
        setRefundModalOpen(false);
        setRefundReason("");
        fetchOrders();
      }
    } catch (err) {
      console.error("Refund error:", err);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Orders & Payment Actions"
        description="View finalized payments, live Razorpay order bindings, audit lineages, and process customer refunds."
      />

      <div className="p-6 space-y-6">
        {/* Controls */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">
              Total Recorded Orders:{" "}
              <Badge variant="secondary" className="font-mono">
                {orders.length}
              </Badge>
            </span>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={fetchOrders}
            className="gap-1.5 text-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </Button>
        </div>

        {/* Orders Table Card */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Settled Orders & Razorpay Bindings</CardTitle>
            <CardDescription>
              Direct linkage between cart mandates and payment transactions
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payment Action ID</TableHead>
                  <TableHead>Cart Mandate</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Razorpay Order ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Timestamp</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-muted-foreground font-sans"
                    >
                      Loading orders...
                    </TableCell>
                  </TableRow>
                ) : error ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-destructive font-sans"
                    >
                      Failed to load orders: {error}
                    </TableCell>
                  </TableRow>
                ) : orders.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-muted-foreground font-sans"
                    >
                      No payment actions found. Run an AI agent simulation to
                      trigger transactions.
                    </TableCell>
                  </TableRow>
                ) : (
                  orders.map((ord) => (
                    <TableRow key={ord.id}>
                      <TableCell className="font-mono font-semibold text-primary">
                        {ord.id}
                      </TableCell>
                      <TableCell className="font-mono text-muted-foreground">
                        {ord.cart_mandate_id}
                      </TableCell>
                      <TableCell className="font-mono font-semibold text-foreground">
                        {formatMinorUnits(ord.amount_minor, ord.currency)}
                      </TableCell>
                      <TableCell className="font-mono">
                        {ord.razorpay_order_id ? (
                          <Badge
                            variant="cyan"
                            className="font-mono text-[10px]"
                          >
                            {ord.razorpay_order_id}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">N/A</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {ord.status === "completed" ? (
                          <Badge variant="success" className="gap-1">
                            <CheckCircle2 className="w-3 h-3" /> Paid & Settled
                          </Badge>
                        ) : ord.status === "refunded" ? (
                          <Badge variant="secondary" className="gap-1">
                            <RotateCcw className="w-3 h-3 text-primary" />{" "}
                            Refunded
                          </Badge>
                        ) : ord.status === "pending_payment" ? (
                          <Badge
                            variant="warning"
                            className="gap-1 animate-pulse"
                          >
                            <Clock className="w-3 h-3" /> Pending Payment
                          </Badge>
                        ) : (
                          <Badge variant="destructive">{ord.status}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-muted-foreground text-[10px]">
                        {new Date(ord.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {ord.status === "pending_payment" &&
                            ord.razorpay_order_id && (
                              <Button
                                size="sm"
                                onClick={() => handlePayWithRazorpay(ord)}
                                disabled={payingOrderId === ord.id}
                                className="gap-1 text-xs"
                              >
                                <CreditCard className="w-3 h-3" />
                                <span>
                                  {payingOrderId === ord.id
                                    ? "Opening..."
                                    : "Pay via Razorpay"}
                                </span>
                              </Button>
                            )}

                          {ord.status === "completed" && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                setSelectedOrder(ord);
                                setRefundModalOpen(true);
                              }}
                              className="gap-1 text-xs"
                            >
                              <RotateCcw className="w-3 h-3 text-primary" />
                              <span>Refund</span>
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Refund Dialog Modal */}
      <Dialog open={refundModalOpen} onOpenChange={setRefundModalOpen}>
        <DialogContent className="max-w-md">
          {selectedOrder && (
            <>
              <DialogHeader>
                <DialogTitle>Issue Customer Refund</DialogTitle>
                <DialogDescription className="font-mono">
                  Action ID: {selectedOrder.id} (
                  {formatMinorUnits(
                    selectedOrder.amount_minor,
                    selectedOrder.currency,
                  )}
                  )
                </DialogDescription>
              </DialogHeader>

              <form onSubmit={handleRefund} className="space-y-4 text-xs">
                <div>
                  <label className="block text-foreground font-medium mb-1">
                    Refund Reason
                  </label>
                  <Textarea
                    rows={3}
                    required
                    value={refundReason}
                    onChange={(e) => setRefundReason(e.target.value)}
                    placeholder="e.g. Agent requested return within 7-day return window..."
                  />
                </div>

                <DialogFooter>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setRefundModalOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={processing}>
                    {processing ? "Processing..." : "Process Refund"}
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
