"use client";

import { RouteError } from "@/app/ui/route-error";
import type { RouteErrorProps } from "@/app/ui/route-error";

export default function ErrorBoundary(props: RouteErrorProps) {
  return <RouteError {...props} title="Unable to load Autograph" />;
}
