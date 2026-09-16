import type { Metadata } from "next";
import { OnboardingWizard } from "@/components/signup/OnboardingWizard";

export const metadata: Metadata = {
  title: "Sign Up — MerchantGate",
  description: "Create your MerchantGate merchant account",
};

export default function SignupPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(0,102,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(0,102,255,0.03)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:linear-gradient(to_bottom,white,transparent_80%)]" />
      <div className="relative flex min-h-screen items-center justify-center px-4 py-12">
        <OnboardingWizard />
      </div>
    </div>
  );
}
