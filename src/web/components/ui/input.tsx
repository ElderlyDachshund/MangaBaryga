import type * as React from "react";
import { cn } from "../../lib/utils";

export function Input({ className, type, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-9 w-full rounded-md border border-stone-300 bg-white px-3 py-1 text-sm text-stone-950 shadow-sm transition-colors placeholder:text-stone-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500",
        className,
      )}
      type={type}
      {...props}
    />
  );
}
