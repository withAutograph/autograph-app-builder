"use client";

import { createElement } from "react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function label({ className, ...props }: ComponentProps<"label">) {
  return createElement("label", {
    className: cn(
      "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
      className,
    ),
    "data-slot": "label",
    ...props,
  });
}

const Label = label;

export { Label };
