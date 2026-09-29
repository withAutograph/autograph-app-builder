import { defineState } from "eve/context";
import { hasTestCapability } from "../testing/test-capability";
import type { SandboxSession, SandboxNetworkPolicy } from "eve/sandbox";

// JustBash has no native identity. This fixture-only durable slot keeps the
// synthetic session's identity across the provider's resume lifecycle.
export const simulatedSandboxIdentity = defineState<string | null>(
  "autograph-app-builder.simulated-sandbox-identity.v1",
  () => null,
);

/** Builder-owned provider capabilities; these are not Eve's common sandbox API. */
export interface BuilderSandboxSession extends SandboxSession {
  readonly id: string;
  readonly setNetworkPolicy: (policy: SandboxNetworkPolicy) => Promise<void>;
}

export const getBuilderSandboxId = (sandbox: SandboxSession): string => {
  const builder: Partial<BuilderSandboxSession> = sandbox;
  if (builder.id === undefined) {
    if (hasTestCapability("simulated-target")) {
      const identity = simulatedSandboxIdentity.get();
      if (identity !== null) {
        return `simulated-${identity}`;
      }
    }
    throw new Error("The Builder sandbox has no connected provider identity.");
  }
  return builder.id;
};

export const setBuilderSandboxNetworkPolicy = async (
  sandbox: SandboxSession,
  policy: SandboxNetworkPolicy,
): Promise<void> => {
  const builder: Partial<BuilderSandboxSession> = sandbox;
  if (builder.setNetworkPolicy === undefined) {
    // The deterministic fixture does not model Vercel's credential egress.
    if (hasTestCapability("simulated-target")) {
      return;
    }
    throw new Error("The Builder sandbox cannot apply its credential network policy.");
  }
  await builder.setNetworkPolicy(policy);
};
