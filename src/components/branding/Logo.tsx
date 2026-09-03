import Link from "next/link";
import { cn } from "@/lib/utils";

type LogoMarkProps = {
  className?: string;
  showNode?: boolean;
};

export function LogoMark({ className, showNode = true }: LogoMarkProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      role="img"
      aria-label="MerchantGate"
      className={cn("h-9 w-9", className)}
    >
      <defs>
        <linearGradient id="mg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0066ff" />
          <stop offset="55%" stopColor="#0052cc" />
          <stop offset="100%" stopColor="#00338d" />
        </linearGradient>
      </defs>
      <g fill="url(#mg-grad)">
        <rect x="5" y="5" width="7" height="38" rx="2" />
        <rect x="5" y="5" width="38" height="7" rx="2" />
        <rect x="36" y="16" width="7" height="27" rx="2" />
      </g>
      {showNode && (
        <>
          <circle cx="22" cy="26" r="4.4" fill="#00b874" />
          <circle cx="22" cy="26" r="2" fill="#ffffff" />
        </>
      )}
    </svg>
  );
}

type LogoLockupProps = {
  className?: string;
  href?: string;
  theme?: "light" | "dark";
};

export function LogoLockup({
  className,
  href = "/dashboard",
  theme = "light",
}: LogoLockupProps) {
  const nameColor = theme === "dark" ? "text-white" : "text-foreground";
  const gateColor = theme === "dark" ? "text-white/90" : "text-[#0066ff]";

  const Lockup = (
    <span className="flex items-center gap-3">
      <LogoMark className="h-9 w-9 shrink-0" />
      <span className="flex items-baseline leading-none whitespace-nowrap">
        <span
          className={cn(
            "font-sans text-xl font-extrabold italic tracking-tight",
            nameColor,
          )}
        >
          Merchant
        </span>
        <span
          className={cn(
            "font-sans text-xl font-extrabold italic tracking-tight",
            gateColor,
          )}
        >
          Gate
        </span>
      </span>
    </span>
  );

  if (!href) return Lockup;

  return (
    <Link href={href} className={cn("inline-flex items-center", className)}>
      {Lockup}
    </Link>
  );
}
