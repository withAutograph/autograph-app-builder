import { AsyncLocalStorage } from "node:async_hooks";

import type { FreshBootstrapCapability } from "@/lib/repository/fresh-bootstrap";
import {
  productionFreshBootstrapCapability,
  type FreshBootstrapFaultHooks,
} from "@/lib/repository/node-fresh-bootstrap";

type FreshBootstrapTestContext = {
  capability: FreshBootstrapCapability;
  hooks?: FreshBootstrapFaultHooks;
};
const structurallyInjectedCapability =
  new AsyncLocalStorage<FreshBootstrapTestContext>();

export function currentFreshBootstrapCapability(): Promise<FreshBootstrapCapability> {
  const injected = structurallyInjectedCapability.getStore()?.capability;
  return injected === undefined
    ? productionFreshBootstrapCapability()
    : Promise.resolve(injected);
}

export function withFreshBootstrapTestCapability<T>(
  capability: FreshBootstrapCapability,
  operation: () => Promise<T>,
  hooks?: FreshBootstrapFaultHooks,
): Promise<T> {
  if (capability.authority !== "structural-test-injection")
    throw new Error(
      "Only an explicit structural test capability can be injected.",
    );
  return structurallyInjectedCapability.run({ capability, hooks }, operation);
}

export function currentFreshBootstrapTestHooks():
  FreshBootstrapFaultHooks | undefined {
  return structurallyInjectedCapability.getStore()?.hooks;
}

export function configuredFreshBootstrapEvalHooks():
  FreshBootstrapFaultHooks | undefined {
  if (
    process.env.APP_BUILDER_TEST_MODEL !== "1" ||
    process.env.APP_BUILDER_FRESH_BOOTSTRAP_EVAL_FAULT !== "after-stage"
  )
    return undefined;
  return {
    afterStageCreation: () => {
      throw new Error("Structurally configured fresh-bootstrap eval fault.");
    },
  };
}
