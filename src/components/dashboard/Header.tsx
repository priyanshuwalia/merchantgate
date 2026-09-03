"use client";

import { Sparkles, Bot } from "lucide-react";
import Link from "next/link";

export function Header({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold leading-7 tracking-tight text-foreground">
          {title}
        </h1>
        {description && (
          <p className="mt-0.5 text-sm font-normal text-text-secondary">
            {description}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Link
          href="/dashboard/simulator"
          className="flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#0052cc]"
        >
          <Bot className="h-5 w-5" />
          <span>Simulate Agent</span>
        </Link>
      </div>
    </div>
  );
}
