"use client";

import { useState } from "react";
import { DashboardShellInner } from "./DashboardShellInner";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <DashboardShellInner
      mobileOpen={mobileOpen}
      onMobileToggle={() => setMobileOpen((v) => !v)}
      onMobileClose={() => setMobileOpen(false)}
    >
      {children}
    </DashboardShellInner>
  );
}
