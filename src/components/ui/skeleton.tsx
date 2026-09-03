import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Lightweight animated placeholder shown while a database value is still
 * loading. Prevents incorrect/default values from flashing before the async
 * data arrives.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
