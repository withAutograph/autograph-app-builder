"use client";

import { useLastLoginMethod } from "@better-auth-ui/react";

import { Badge } from "@/components/ui/badge";

export interface LastUsedBadgeProps {
  /** Login method IDs that should display the indicator. */
  method: string | string[];
  /** Use the shorter label in constrained layouts. */
  compact?: boolean;
  /** Float the compact indicator over the top-right edge of its container. */
  floating?: boolean;
}

/**
 * Displays an indicator when one of the supplied method IDs matches Better
 * Auth's stored last login method.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function LastUsedBadge({ method, compact, floating }: LastUsedBadgeProps) {
  const { method: lastLoginMethod, localization } = useLastLoginMethod();
  const methods = Array.isArray(method) ? method : [method];

  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
  if (!lastLoginMethod || !methods.includes(lastLoginMethod)) {
    return null;
  }
  /* oxlint-enable typescript/strict-boolean-expressions */

  const shortLabel = (compact ?? false) || (floating ?? false);

  return (
    <Badge
      className={
        (floating ?? false)
          ? "pointer-events-none absolute top-0 right-0 z-10 translate-x-1/4 -translate-y-1/2 shadow-sm"
          : undefined
      }
      variant="secondary"
    >
      {shortLabel ? localization.lastUsedShort : localization.lastUsed}
    </Badge>
  );
}
