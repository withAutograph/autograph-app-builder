import type { IntegrationProviderDiagnostic } from "./app-integration-provider-diagnostic";
import type { PublicReleaseInvocation } from "./public-release-handler";
import type {
  AppIntegrationCapabilityPlan,
  IntegrationCapabilityEffect,
  IntegrationCapabilityReceipt,
} from "./app-integration-capability-contract";

export interface AppIntegrationCapabilityEffectContext {
  invocation: PublicReleaseInvocation;
  plan: AppIntegrationCapabilityPlan;
  operationRef: string;
  planDigest: string;
  effect: IntegrationCapabilityEffect;
  priorPhase: "idle" | "pending";
  /** New lease ownership and the durable generation dispatched for this effect are distinct. */
  fenceGeneration: number;
  attemptGeneration: number;
  /** Physical project/database lease, canonical owner, exact current profile and ordinary approval. */
  assertCurrent: () => Promise<void>;
  /** Durable receipt before an external dispatch may be retried; never secret-bearing. */
  checkpoint: {
    read: () => Promise<IntegrationCapabilityReceipt | undefined>;
    recordAccepted: (receipt: IntegrationCapabilityReceipt) => Promise<void>;
  };
}
export interface AppIntegrationCapabilityWorker {
  reconcile: (
    context: AppIntegrationCapabilityEffectContext,
  ) => Promise<
    | { status: "applied"; receipt: IntegrationCapabilityReceipt }
    | { status: "not-applied"; proof: "authoritative-effect-not-applied" }
    | { status: "unknown"; diagnostic?:IntegrationProviderDiagnostic }
  >;
  execute: (
    context: AppIntegrationCapabilityEffectContext,
  ) => Promise<IntegrationCapabilityReceipt>;
}
