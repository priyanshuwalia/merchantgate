"use client";

import { AlertCircle, ArrowRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface AccountStepProps {
  onComplete: (data: {
    merchantId: string;
    apiKey: string;
    email: string;
    storeName: string;
  }) => void;
  initialState: { email: string; storeName: string };
}

export function AccountStep({ onComplete, initialState }: AccountStepProps) {
  const [email, setEmail] = useState(initialState.email);
  const [storeName, setStoreName] = useState(initialState.storeName);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (!storeName.trim()) {
      setError("Please enter a store name.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          storeName: storeName.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message || "Signup failed. Please try again.");
        return;
      }

      onComplete({
        merchantId: data.merchantId,
        apiKey: data.apiKey,
        email: email.trim(),
        storeName: storeName.trim(),
      });
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Create your account
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          This will be your login credentials for the merchant dashboard.
        </p>
      </div>

      <div className="space-y-3">
        <div>
          <label
            htmlFor="storeName"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            Store name
          </label>
          <Input
            id="storeName"
            placeholder="e.g. Nimbus Gear & Electronics"
            value={storeName}
            onChange={(e) => setStoreName(e.target.value)}
            autoFocus
          />
        </div>

        <div>
          <label
            htmlFor="email"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            Email address
          </label>
          <Input
            id="email"
            type="email"
            placeholder="you@store.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            Password
          </label>
          <Input
            id="password"
            type="password"
            placeholder="At least 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <div>
          <label
            htmlFor="confirmPassword"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            Confirm password
          </label>
          <Input
            id="confirmPassword"
            type="password"
            placeholder="Re-enter your password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-error/5 p-3 text-sm text-error">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <Button
        type="submit"
        className="w-full"
        size="lg"
        disabled={loading}
        data-icon="inline-end"
      >
        {loading ? "Creating account..." : "Continue"}
        {!loading && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
