"use client";

import {
  Activity,
  BarChart3,
  Cpu,
  LayoutDashboard,
  Megaphone,
  MessagesSquare,
  Package,
  ScrollText,
  Settings,
  ShieldCheck,
  ShoppingBag,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LogoMark } from "@/components/branding/Logo";

const NAV_ITEMS = [
  { label: "Overview", href: "/dashboard", icon: LayoutDashboard },
  { label: "Products", href: "/dashboard/products", icon: Package },
  { label: "Requests", href: "/dashboard/requests", icon: Activity },
  { label: "Orders", href: "/dashboard/orders", icon: ShoppingBag },
  { label: "Policies", href: "/dashboard/policies", icon: ShieldCheck },
  { label: "Campaigns", href: "/dashboard/campaigns", icon: Megaphone },
  {
    label: "Inventory Agent",
    href: "/dashboard/inventory-agent",
    icon: MessagesSquare,
  },
  { label: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
  { label: "Simulator", href: "/dashboard/simulator", icon: Cpu },
  {
    label: "Audit Trail",
    href: "/dashboard/audit",
    icon: ScrollText,
  },
  {
    label: "Webhooks",
    href: "/dashboard/webhook-inspector",
    icon: ShieldCheck,
  },
];

const ACCOUNT_ITEMS = [
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
];

function SidebarContent({
  pathname,
  onMobileNavigate,
}: {
  pathname: string;
  onMobileNavigate?: () => void;
}) {
  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === href : pathname.startsWith(href);

  return (
    <div className="flex h-full flex-col">
      <nav className="flex-1 space-y-6 overflow-y-auto px-4 py-6">
        {/* General */}
        <div>
          <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Commerce
          </div>
          <div className="space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onMobileNavigate}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-200",
                    active
                      ? "bg-accent text-primary"
                      : "text-text-secondary hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      active ? "text-primary" : "text-text-muted",
                    )}
                  />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Account */}
        <div>
          <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Account
          </div>
          <div className="space-y-0.5">
            {ACCOUNT_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onMobileNavigate}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-200",
                    active
                      ? "bg-accent text-primary"
                      : "text-text-secondary hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      active ? "text-primary" : "text-text-muted",
                    )}
                  />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Footer Info */}
      <div className="border-t border-border p-4">
        <div className="rounded-lg border border-border bg-muted p-3 space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-text-muted">
              <LogoMark className="h-4 w-4" showNode={false} />
              Merchant
            </span>
            <span className="font-medium text-foreground">Nimbus Gear</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-text-muted">Payments</span>
            <span className="flex items-center gap-1.5 font-medium text-[#00b874]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#00b874]" />
              Razorpay
            </span>
          </div>
        </div>
        <p className="mt-3 text-center text-[11px] text-text-muted">
          Protocol{" "}
          <code className="font-mono text-primary">agentpay-commerce.v1</code>
        </p>
      </div>
    </div>
  );
}

export function Sidebar({
  mobileOpen,
  onMobileNavigate,
}: {
  mobileOpen?: boolean;
  onMobileNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <>
      {/* Desktop sidebar — fixed below navbar */}
      <aside className="fixed bottom-0 left-0 top-16 z-[900] hidden w-60 select-none border-r border-border bg-white lg:block">
        <SidebarContent pathname={pathname} />
      </aside>

      {/* Mobile drawer sidebar */}
      <aside
        className={cn(
          "fixed bottom-0 left-0 top-16 z-[999] w-60 select-none border-r border-border bg-white transition-transform duration-300 ease-out lg:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <SidebarContent
          pathname={pathname}
          onMobileNavigate={onMobileNavigate}
        />
      </aside>
    </>
  );
}
