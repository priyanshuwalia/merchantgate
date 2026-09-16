import type React from "react";
import { requirePageAuth } from "@/lib/auth/guard";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePageAuth();
  return <>{children}</>;
}
