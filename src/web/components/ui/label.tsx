import * as LabelPrimitive from "@radix-ui/react-label";
import type * as React from "react";
import { cn } from "../../lib/utils";

export function Label({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn("text-xs font-semibold text-stone-700", className)}
      {...props}
    />
  );
}
