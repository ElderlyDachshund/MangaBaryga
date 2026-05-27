import type * as React from "react";
import { cn } from "../../lib/utils";

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "flex h-9 w-full rounded-md border border-stone-300 bg-white px-3 py-1 text-sm text-stone-950 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500",
        className,
      )}
      {...props}
    />
  );
}
