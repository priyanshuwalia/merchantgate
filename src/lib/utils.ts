import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { ulid } from "ulid";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatMinorUnits(
  amountMinor: number,
  currency = "INR",
): string {
  const amount = (amountMinor || 0) / 100;
  if (currency.toUpperCase() === "INR") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 2,
    }).format(amount);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(amount);
}

export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

export function fromMinorUnits(amountMinor: number): number {
  return amountMinor / 100;
}

export function generateId(prefix = ""): string {
  const id = ulid().toLowerCase();
  return prefix ? `${prefix}_${id}` : id;
}

export function generateTraceId(): string {
  return `trace_${ulid().toLowerCase()}`;
}
