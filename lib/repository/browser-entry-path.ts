import { z } from "zod";

/** A browser destination is a path; it never changes the exact Auth origin. */
export const isCanonicalBrowserEntryPath = (value: string): boolean =>
  value.startsWith("/") &&
  !value.startsWith("//") &&
  !/[\p{Cc}:%*?#\\]/u.test(value) &&
  new URL(value, "https://app.invalid").pathname === value;
export const browserEntryPathSchema = z.string().refine(isCanonicalBrowserEntryPath);

/** New app:describe results use the full official matcher; legacy descriptions allow only a unique literal. */
export const describedBrowserEntryPath = (app: {
  routes: readonly string[];
  browserEntryPath?: string | null;
}): string | null => {
  if (app.browserEntryPath !== undefined) {
    return app.browserEntryPath !== null && isCanonicalBrowserEntryPath(app.browserEntryPath)
      ? app.browserEntryPath
      : null;
  }
  const literals = [...new Set(app.routes.filter(isCanonicalBrowserEntryPath))];
  return literals.length === 1 ? (literals[0] ?? null) : null;
};
