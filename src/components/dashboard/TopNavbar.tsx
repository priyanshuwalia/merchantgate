"use client";

import { Globe, Menu } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { LogoLockup } from "@/components/branding/Logo";

export function TopNavbar({ onMobileToggle }: { onMobileToggle: () => void }) {
  return (
    <header className="fixed inset-x-0 top-0 z-[1000] flex h-16 items-center justify-between border-b border-border bg-black text-white px-4 lg:px-8">
      <div className="flex items-center gap-3">
        {/* Hamburger (mobile only) */}
        <button
          type="button"
          onClick={onMobileToggle}
          className="rounded-md p-2 text-text-secondary transition-colors hover:bg-muted hover:text-foreground lg:hidden"
          aria-label="Toggle navigation"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Logo */}
        <LogoLockup href="/dashboard" theme="dark" className="pl-1" />
      </div>

      <div className="flex items-center gap-3">
        {/* Discovery Manifest */}
        <Link
          href="/.well-known/agent-commerce.json"
          target="_blank"
          title="Agent discovery manifest"
          className={cn(
            "hidden items-center gap-1.5 rounded-md border border-border bg-white px-3 py-2 text-xs font-medium text-text-secondary transition-colors sm:flex",
            "hover:border-primary hover:text-primary",
          )}
        >
          <Globe className="h-3.5 w-3.5 text-primary" />
          <span className="hidden lg:inline">Discovery Manifest</span>
        </Link>

        {/* Avatar */}
        <div
          className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-primary"
          title="Merchant account"
        >
          N
        </div>
      </div>
    </header>
  );
}
