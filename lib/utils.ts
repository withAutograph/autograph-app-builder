import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
