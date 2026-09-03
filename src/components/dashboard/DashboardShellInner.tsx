"use client";

import { Sidebar } from "./Sidebar";
import { TopNavbar } from "./TopNavbar";

export function DashboardShellInner({
  mobileOpen,
  onMobileToggle,
  onMobileClose,
  children,
}: {
  mobileOpen: boolean;
  onMobileToggle: () => void;
  onMobileClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top Navigation Bar — 64px, fixed, full width */}
      <TopNavbar onMobileToggle={onMobileToggle} />

      {/* Left Sidebar — 240px, fixed below navbar */}
      <Sidebar mobileOpen={mobileOpen} onMobileNavigate={onMobileClose} />

      {/* Backdrop for mobile drawer */}
      {mobileOpen && (
        <div
          className="fixed inset-0 top-16 z-[998] bg-black/30 lg:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}

      {/* Main Content Area — offset by sidebar */}
      <div className="pt-16 lg:pl-60">
        <main className="min-h-[calc(100vh-64px)] p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
