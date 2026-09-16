"use client";

import { ArrowRight, LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogoLockup } from "@/components/branding/Logo";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        router.replace("/dashboard");
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(
          data.message ||
            "Sign-in failed. Check your credentials and try again.",
        );
      }
    } catch {
      setError("Sign-in failed. Check your credentials and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 text-foreground">
      {/* Subtle grid background, matching the public landing page */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background-size:40px_40px] [background-image:linear-gradient(to_right,#e8edf2_1px,transparent_1px),linear-gradient(to_bottom,#e8edf2_1px,transparent_1px)] opacity-40"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background via-transparent to-background"
      />

      <div className="relative z-10 flex w-full max-w-sm flex-col items-center">
        <LogoLockup
          href="/"
          className="mb-8 transition-opacity hover:opacity-90"
        />

        <Card className="w-full border-border/80 shadow-md">
          <CardHeader>
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0066ff]/10 text-[#0066ff]">
                <LockKeyhole className="h-4 w-4" />
              </div>
              <CardTitle className="text-lg">Merchant Sign In</CardTitle>
            </div>
            <CardDescription>
              Access the MerchantGate console — policies, quotes, orders, and
              the audit trail for your AI buyer agents.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={onSubmit} className="space-y-5">
              <div className="space-y-1.5">
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-foreground"
                >
                  Email address
                </label>
                <div className="relative">
                  <UserRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    autoFocus
                    className="pl-9"
                    placeholder="you@store.com"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-foreground"
                >
                  Password
                </label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                />
              </div>

              {error && (
                <div className="rounded-md border border-[#f44336]/25 bg-[#f44336]/[0.06] px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={loading || !password || !email}
                className="w-full"
                size="lg"
              >
                {loading ? "Signing in…" : "Sign in"}
                {!loading && (
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                )}
              </Button>

              <div className="flex items-center gap-2 pt-1 text-xs text-text-muted">
                <ShieldCheck className="h-3.5 w-3.5 text-[#00b874]" />
                <span>Session-secured, HMAC-signed cookie.</span>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="mt-6 flex w-full items-center justify-between">
          <Link
            href="/"
            className="text-xs font-medium text-text-muted transition-colors hover:text-primary"
          >
            ← Back to home
          </Link>
          <Link
            href="/signup"
            className="text-xs font-medium text-primary transition-colors hover:underline"
          >
            New to MerchantGate? Sign up
          </Link>
        </div>
      </div>
    </main>
  );
}
