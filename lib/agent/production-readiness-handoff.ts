import type { SandboxSession } from "eve/sandbox";
import type { PreparedRuntimeExecution } from "./prepared-runtime-execution";

import { describeSelectedApp } from "@/lib/repository/app-description";
import type { AppDescription } from "@/lib/repository/app-description";
import type { ProductBehaviorEvidence } from "./product-behavior-state";

interface SourceDescriptionRunner {
  run?: SandboxSession["run"];
}

const sourceDescription = async (input: {
  appId: string;
  repositoryRoot: string;
  source: SourceDescriptionRunner;
  signal?: AbortSignal;
}): Promise<{ description: AppDescription | null; blockers: string[] }> => {
  const { run } = input.source;
  if (run === undefined) {
    return {
      blockers: [
        "The selected app has not been described by its repository's app:describe command.",
      ],
      description: null,
    };
  }
  try {
    const description = await describeSelectedApp({
      appId: input.appId,
      root: input.repositoryRoot,
      sandbox: { run: async (command) => await run.call(input.source, command) },
      signal: input.signal,
    });
    return { blockers: [], description };
  } catch (error) {
    input.signal?.throwIfAborted();
    return {
      blockers: [
        `The repository's app:describe command could not describe the selected app: ${error instanceof Error ? error.message : "No command diagnostic was available."}`,
      ],
      description: null,
    };
  }
};

const runtimeEvidence = (
  backend: AppDescription["backend"] | undefined,
  behaviorEvidence: readonly ProductBehaviorEvidence[],
  installationProof?: PreparedRuntimeExecution["installationProof"],
) => {
  const generatedBackend = backend?.kind === "generated-postgres" ? backend : null;
  const staticApp = backend?.kind === "static";
  const matchingInstallation =
    installationProof !== undefined &&
    generatedBackend !== null &&
    installationProof.releaseId === generatedBackend.release.id &&
    installationProof.artifactHash === generatedBackend.release.artifactHash;
  return {
    authenticatedSchemaReceipt: {
      contract: generatedBackend?.schemaReceipt?.contract ?? null,
      path: generatedBackend?.schemaReceipt?.path ?? null,
      reason: staticApp
        ? "The repository describes this app as static."
        : "A declared receipt route does not establish authenticated access or its response behavior.",
      status: staticApp ? ("not-applicable" as const) : ("unassessed" as const),
    },
    behavior: {
      coverage:
        behaviorEvidence.length === 0 ? ("unassessed" as const) : ("action-readback-only" as const),
      results: behaviorEvidence,
      unassessed: [
        "authentication",
        "tenant-isolation",
        "revocation",
        "concurrent-decisions",
        "idempotent-submission",
        "audit-history",
        "restart-durability",
      ],
    },
    installedRelease: matchingInstallation
      ? { observation: installationProof, status: "passed" as const }
      : {
          reason: staticApp
            ? "The repository describes this app as static."
            : "A checked source release does not establish installation in the selected database.",
          status: staticApp ? ("not-applicable" as const) : ("unassessed" as const),
        },
  };
};

/** Source capabilities and recorded observations, never an activation or readiness decision. */
export const productionReadinessHandoff = async (input: {
  appId: string;
  repositoryRoot: string;
  source: SourceDescriptionRunner;
  installationProof?: PreparedRuntimeExecution["installationProof"];
  productBehaviorEvidence?: readonly ProductBehaviorEvidence[];
  signal?: AbortSignal;
}) => {
  const { description, blockers } = await sourceDescription(input);
  const backend = description?.backend;
  const generatedBackend = backend?.kind === "generated-postgres" ? backend : null;
  const routes = description?.app.routes ?? [];
  return {
    appId: input.appId,
    blockers,
    checkedRelease:
      generatedBackend === null
        ? null
        : {
            artifactHash: generatedBackend.release.artifactHash,
            releaseId: generatedBackend.release.id,
          },
    description,
    evidence: runtimeEvidence(
      backend,
      input.productBehaviorEvidence ?? [],
      input.installationProof?.appId === input.appId ? input.installationProof : undefined,
    ),
    nextSteps: [
      "Review this app's source, declared capabilities, and recorded runtime observations.",
      "Verify the selected database's installed release and authenticated schema receipt.",
      "Exercise authenticated product outcomes, denied access, tenant isolation, and durable persistence in Preview.",
      "Obtain separate operator approval for hosted preparation and provider activation, then run semantic read-only Production proof.",
    ],
    roles: generatedBackend?.roles ?? [],
    route: routes[0] ?? null,
    routes,
    schemaReceiptPath: generatedBackend?.schemaReceipt?.path ?? null,
    status: "operator-review-required" as const,
  };
};
