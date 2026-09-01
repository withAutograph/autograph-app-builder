import { createHash } from "node:crypto";

export function canonicalHostedValue(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalHostedValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalHostedValue(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hostedValueDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalHostedValue(value))
    .digest("hex")}`;
}

export function stableHostedId(prefix: string, value: unknown): string {
  return `${prefix}_${hostedValueDigest(value).slice("sha256:".length)}`;
}
