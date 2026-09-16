import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-white",
        secondary:
          "border-transparent bg-secondary text-text-secondary hover:bg-[#e4eaf1]",
        destructive:
          "border-[#f44336]/25 bg-[#f44336]/[0.08] text-destructive hover:bg-[#f44336]/[0.15]",
        outline: "border-border bg-white text-text-muted hover:bg-muted",
        success:
          "border-[#00b874]/25 bg-[#00b874]/[0.08] text-[#00875c] hover:bg-[#00b874]/[0.15]",
        warning:
          "border-[#ffb822]/40 bg-[#ffb822]/[0.12] text-[#946400] hover:bg-[#ffb822]/[0.2]",
        cyan: "border-primary/20 bg-accent text-primary hover:bg-accent/70",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
