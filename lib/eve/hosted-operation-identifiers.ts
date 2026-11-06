import { createHash } from "node:crypto";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function canonical(value: CanonicalValue): string {
  if (Array.isArray(value)) {
    return `[${(value as readonly CanonicalValue[]).map(canonical).join(",")}]`;
  }
  if (value !== null && !Array.isArray(value)) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function digest(value: CanonicalValue): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function stableId(prefix: string, value: CanonicalValue): string {
  return `${prefix}_${digest(value).slice("sha256:".length)}`;
}
