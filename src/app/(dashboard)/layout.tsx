import type React from "react";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = {
  title: "Merchant Dashboard",
  description: "AI-Native Merchant Platform for Autonomous Buyer Agents",
  // Session-gated: never surface a merchant's console in search results.
  robots: { index: false, follow: false },
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePageAuth();
  return <DashboardShell>{children}</DashboardShell>;
}
