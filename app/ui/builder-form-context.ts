"use client";

import { createContext, useContext } from "react";
import type { useBuilderController } from "./use-builder-controller";

export const BuilderControllerContext = createContext<ReturnType<
  typeof useBuilderController
> | null>(null);

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function useBuilderControllerContext() {
  const controller = useContext(BuilderControllerContext);
  if (!controller) throw new Error("Builder fields require the builder controller.");
  return controller;
}
