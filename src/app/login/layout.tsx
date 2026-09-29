import type { Metadata } from "next";

// The sign-in page is a client component and can't export `metadata`, so it is
// declared here instead.
export const metadata: Metadata = {
  title: "Sign In",
  description: "Sign in to your MerchantGate merchant console.",
  robots: { index: false, follow: false },
};

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
