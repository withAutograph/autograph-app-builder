import { z } from "zod";

export const builderAppIdSchema = z
  .string()
  .min(1)
  .max(92)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export function deriveBuilderAppId(appName: string): string {
  const value = appName
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 92)
    .replaceAll(/-+$/gu, "");
  return builderAppIdSchema.parse(value);
}

export function suffixedProviderName(input: {
  base: string;
  suffix: string;
  maximumLength: number;
}) {
  const suffix = z
    .string()
    .regex(/^[a-z0-9]{6}$/u)
    .parse(input.suffix);
  const maximumLength = z.number().int().min(8).parse(input.maximumLength);
  const trimmed = input.base
    .slice(0, maximumLength - suffix.length - 1)
    .replaceAll(/-+$/gu, "");
  return `${trimmed}-${suffix}`;
}
