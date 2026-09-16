"use client";

import { ArrowRight, Check, Key, Package, Rocket, Store } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ReviewStepProps {
  storeName: string;
  email: string;
  apiKey: string;
  productCount: number;
  onLaunch: () => void;
}

export function ReviewStep({
  storeName,
  email,
  apiKey,
  productCount,
  onLaunch,
}: ReviewStepProps) {
  const items = [
    {
      icon: Store,
      label: "Store",
      value: storeName,
      done: true,
    },
    {
      icon: Key,
      label: "API Key",
      value: apiKey ? "Generated" : "Not set up",
      done: !!apiKey,
    },
    {
      icon: Package,
      label: "Products",
      value:
        productCount > 0
          ? `${productCount} product${productCount > 1 ? "s" : ""} added`
          : "No products yet",
      done: productCount > 0,
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          You&apos;re all set!
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          Here&apos;s a summary of your store setup.
        </p>
      </div>

      <div className="space-y-2">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 p-3"
          >
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full ${
                item.done
                  ? "bg-success/10 text-success"
                  : "bg-secondary text-text-muted"
              }`}
            >
              <item.icon className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground">
                {item.label}
              </p>
              <p className="text-xs text-text-muted">{item.value}</p>
            </div>
            {item.done && <Check className="h-4 w-4 text-success" />}
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border bg-secondary/30 p-3">
        <p className="text-xs text-text-muted">
          <strong className="text-foreground">Logged in as</strong>{" "}
          <span className="font-mono">{email}</span>
        </p>
      </div>

      <Button
        className="w-full"
        size="lg"
        onClick={onLaunch}
        data-icon="inline-end"
      >
        <Rocket className="h-4 w-4" />
        Launch Dashboard
        <ArrowRight className="h-4 w-4" />
      </Button>

      <p className="text-center text-xs text-text-muted">
        You can configure policies, campaigns, and settings from the dashboard
        at any time.
      </p>
    </div>
  );
}
