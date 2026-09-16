"use client";

import { AlertCircle, ArrowRight, Lightbulb, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Product {
  title: string;
  category: string;
  price: number;
  stock: number;
}

interface CatalogueStepProps {
  onComplete: (products: Product[]) => void;
  onSkip: () => void;
}

const CATEGORIES = [
  "electronics",
  "audio",
  "accessories",
  "computers",
  "office",
];

export function CatalogueStep({ onComplete, onSkip }: CatalogueStepProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [current, setCurrent] = useState<Product>({
    title: "",
    category: "electronics",
    price: 0,
    stock: 10,
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const addProduct = () => {
    if (!current.title.trim()) {
      setError("Product title is required.");
      return;
    }
    if (current.price <= 0) {
      setError("Price must be greater than zero.");
      return;
    }
    setError("");
    setProducts((prev) => [...prev, { ...current }]);
    setCurrent({ title: "", category: current.category, price: 0, stock: 10 });
  };

  const removeProduct = (index: number) => {
    setProducts((prev) => prev.filter((_, i) => i !== index));
  };

  const handleContinue = async () => {
    if (products.length === 0) {
      onComplete([]);
      return;
    }

    setLoading(true);
    try {
      for (const p of products) {
        await fetch("/api/merchant/products", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-merchant-csrf": "1",
          },
          body: JSON.stringify({
            title: p.title,
            category: p.category,
            base_price_minor: Math.round(p.price * 100),
            stock_quantity: p.stock,
          }),
        });
      }
      onComplete(products);
    } catch {
      setError(
        "Failed to add some products. You can add them later from the dashboard.",
      );
      onComplete(products);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Add products to your catalogue
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          Add a few products to get started. You can always add more from the
          dashboard.
        </p>
      </div>

      <div className="flex items-start gap-2.5 rounded-lg border border-info/20 bg-info/5 p-3">
        <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        <div className="text-xs leading-relaxed text-text-secondary">
          <p className="mb-1 font-medium text-foreground">
            Tips for your catalogue
          </p>
          <ul className="list-inside list-disc space-y-0.5">
            <li>
              Each product gets a <strong>variant_id</strong> (SKU) — used by
              agents to reference items
            </li>
            <li>
              Prices are in your currency&apos;s <strong>minor units</strong>{" "}
              (e.g. paise for INR) — enter the main amount, we&apos;ll convert
            </li>
            <li>
              Set <strong>stock = 0</strong> for out-of-stock items — agents
              will see them but can&apos;t purchase
            </li>
          </ul>
        </div>
      </div>

      <div className="space-y-2">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2">
          <Input
            placeholder="Product name"
            value={current.title}
            onChange={(e) =>
              setCurrent((prev) => ({ ...prev, title: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addProduct();
              }
            }}
          />
          <select
            value={current.category}
            onChange={(e) =>
              setCurrent((prev) => ({ ...prev, category: e.target.value }))
            }
            className="h-9 rounded-md border border-border bg-white px-2 text-sm"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <Input
            type="number"
            placeholder="Price"
            min={0}
            className="w-24"
            value={current.price || ""}
            onChange={(e) =>
              setCurrent((prev) => ({
                ...prev,
                price: Number(e.target.value),
              }))
            }
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={addProduct}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-error/5 p-2 text-xs text-error">
            <AlertCircle className="h-3 w-3 shrink-0" />
            {error}
          </div>
        )}

        {products.length > 0 && (
          <div className="space-y-1.5 pt-1">
            {products.map((p, i) => (
              <div
                key={`${p.title}-${i}`}
                className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm"
              >
                <div className="flex-1 truncate">
                  <span className="font-medium">{p.title}</span>
                  <span className="ml-2 text-text-muted">{p.category}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs">
                    {p.price.toLocaleString()}
                  </span>
                  <span className="text-xs text-text-muted">×{p.stock}</span>
                  <button
                    type="button"
                    onClick={() => removeProduct(i)}
                    className="text-text-muted hover:text-error transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-3 pt-2">
        <Button variant="outline" className="flex-1" onClick={onSkip}>
          Skip for now
        </Button>
        <Button
          className="flex-1"
          onClick={handleContinue}
          disabled={loading}
          data-icon="inline-end"
        >
          {loading
            ? "Adding products..."
            : products.length > 0
              ? `Add ${products.length} product${products.length > 1 ? "s" : ""}`
              : "Continue"}
          {!loading && <ArrowRight className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
