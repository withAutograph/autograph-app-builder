"use client";

import { createContext, useContext } from "react";
import type { useBuilderController } from "./use-builder-controller";

export const BuilderControllerContext = createContext<ReturnType<
  typeof useBuilderController
> | null>(null);

export function useBuilderControllerContext() {
  const controller = useContext(BuilderControllerContext);
  if (!controller) {
    throw new Error("Builder fields require the builder controller.");
  }
  return controller;
}
