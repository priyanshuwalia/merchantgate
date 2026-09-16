"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { AccountStep } from "./steps/AccountStep";
import { ApiKeyStep } from "./steps/ApiKeyStep";
import { CatalogueStep } from "./steps/CatalogueStep";
import { ReviewStep } from "./steps/ReviewStep";

const STEPS = [
  { id: "account", label: "Account" },
  { id: "apikey", label: "API Key" },
  { id: "catalogue", label: "Catalogue" },
  { id: "review", label: "Launch" },
] as const;

interface WizardState {
  merchantId: string;
  apiKey: string;
  email: string;
  storeName: string;
  products: Array<{
    title: string;
    category: string;
    price: number;
    stock: number;
  }>;
}

export function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [state, setState] = useState<WizardState>({
    merchantId: "",
    apiKey: "",
    email: "",
    storeName: "",
    products: [],
  });

  const markComplete = useCallback((stepIndex: number) => {
    setCompletedSteps((prev) => new Set(prev).add(stepIndex));
  }, []);

  const handleAccountComplete = useCallback(
    (data: {
      merchantId: string;
      apiKey: string;
      email: string;
      storeName: string;
    }) => {
      setState((prev) => ({ ...prev, ...data }));
      markComplete(0);
      setStep(1);
    },
    [markComplete],
  );

  const handleApiKeyComplete = useCallback(() => {
    markComplete(1);
    setStep(2);
  }, [markComplete]);

  const handleCatalogueComplete = useCallback(
    (products: WizardState["products"]) => {
      setState((prev) => ({ ...prev, products }));
      markComplete(2);
      setStep(3);
    },
    [markComplete],
  );

  const handleLaunch = useCallback(async () => {
    try {
      await fetch("/api/merchant/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-merchant-csrf": "1" },
        body: JSON.stringify({ onboardingCompleted: true }),
      });
    } catch {
      // Proceed even if this fails — onboarding state is non-critical
    }
    router.push("/dashboard");
  }, [router]);

  const handleSkip = useCallback(() => {
    if (step < STEPS.length - 1) {
      markComplete(step);
      setStep(step + 1);
    }
  }, [step, markComplete]);

  return (
    <div className="w-full max-w-xl">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Set up your store
        </h1>
        <p className="mt-2 text-sm text-text-muted">
          Get your merchant account ready for AI buyer agents
        </p>
      </div>

      <div className="mb-8 flex items-center justify-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors ${
                completedSteps.has(i)
                  ? "border-success bg-success text-white"
                  : i === step
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-white text-text-muted"
              }`}
            >
              {completedSteps.has(i) ? <Check className="h-4 w-4" /> : i + 1}
            </div>
            <span
              className={`text-xs font-medium hidden sm:block ${
                i === step ? "text-foreground" : "text-text-muted"
              }`}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <div
                className={`h-px w-8 ${
                  completedSteps.has(i) ? "bg-success" : "bg-border"
                }`}
              />
            )}
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-white p-6 shadow-sm">
        {step === 0 && (
          <AccountStep
            onComplete={handleAccountComplete}
            initialState={state}
          />
        )}
        {step === 1 && (
          <ApiKeyStep
            apiKey={state.apiKey}
            onComplete={handleApiKeyComplete}
            onSkip={handleSkip}
          />
        )}
        {step === 2 && (
          <CatalogueStep
            onComplete={handleCatalogueComplete}
            onSkip={handleSkip}
          />
        )}
        {step === 3 && (
          <ReviewStep
            storeName={state.storeName}
            email={state.email}
            apiKey={state.apiKey}
            productCount={state.products.length}
            onLaunch={handleLaunch}
          />
        )}
      </div>

      <p className="mt-6 text-center text-xs text-text-muted">
        Already have an account?{" "}
        <a href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </a>
      </p>
    </div>
  );
}
