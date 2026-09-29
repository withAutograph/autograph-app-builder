import type { SandboxSession } from "eve/sandbox";
import type { PreparedRuntimeExecution } from "./prepared-runtime-execution";

import { describeSelectedApp } from "@/lib/repository/app-description";
import type { AppDescription } from "@/lib/repository/app-description";
import type { ProductBehaviorEvidence } from "./product-behavior-state";

interface SourceDescriptionRunner {
  run?: SandboxSession["run"];
}

const generatedBackendKind = "generated-postgres";
const notApplicable = "not-applicable" as const;

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
  const generatedBackend = backend?.kind === generatedBackendKind ? backend : null;
  const staticApp = backend?.kind === "static";
  const matchingInstallation =
    installationProof !== undefined &&
    generatedBackend !== null &&
    installationProof.releaseId === generatedBackend.release.id &&
    installationProof.artifactHash.replace(/^sha256:/u, "") ===
      generatedBackend.release.artifactHash.replace(/^sha256:/u, "");
  return {
    authenticatedSchemaReceipt: {
      contract: generatedBackend?.schemaReceipt?.contract ?? null,
      path: generatedBackend?.schemaReceipt?.path ?? null,
      reason: staticApp
        ? "The repository describes this app as static."
        : "A declared receipt route does not establish authenticated access or its response behavior.",
      status: staticApp ? notApplicable : ("unassessed" as const),
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
          status: staticApp ? notApplicable : ("unassessed" as const),
        },
  };
};

const nativeInstallerIsolation = (backend: AppDescription["backend"] | undefined) => {
  if (backend?.kind === "static") {
    return {
      reason:
        "The repository describes this app as static; no generated database installer is required.",
      requiredEvidence: [],
      status: notApplicable,
    };
  }
  if (backend === undefined) {
    return {
      reason: "The repository has not described this app's database capability.",
      requiredEvidence: ["Describe the selected app before assessing its installer boundary."],
      status: "unassessed" as const,
    };
  }
  return {
    reason:
      "Native Services shares project environment variables. The current Neon integration can inject installer credentials into app processes; restricted runtime selection and private Sandbox verification do not prove their absence in native services.",
    requiredEvidence: [
      "Configure a supported provider credential boundary and verify every app service lacks installer credentials, including native URLs, raw password variables and legacy connection variables.",
    ],
    status: "blocked" as const,
  };
};

const operatorChecklist = (
  appId: string,
  description: AppDescription | null,
  evidence: ReturnType<typeof runtimeEvidence>,
) => {
  const backend = description?.backend;
  const generated = backend?.kind === generatedBackendKind ? backend : null;
  const staticApp = backend?.kind === "static";
  const persistenceStatus = staticApp ? notApplicable : ("unassessed" as const);
  return {
    accessGrants: {
      appId,
      authorization: generated?.authorization ?? null,
      declaredRoles: generated?.roles ?? [],
      requiredEvidence: [
        "Record the intended organization, its app assignment, active members and approved server-owned role grants.",
        "Verify authorized access, denied access and revocation using authenticated identities.",
      ],
      status: "unassessed" as const,
    },
    approvals: {
      required: [
        { effect: "hosted-preparation", status: "unassessed" as const },
        { effect: "access-grants", status: "unassessed" as const },
        { effect: "provider-activation", status: "unassessed" as const },
        { effect: "recovery-or-cleanup", status: "unassessed" as const },
      ],
      requirement:
        "Obtain separate operator approvals naming the target environment and resources before preparation, access changes, activation or destructive recovery. Preview installation evidence grants no Production authority.",
      status: "unassessed" as const,
    },
    backupRecovery: {
      requiredEvidence: staticApp
        ? []
        : [
            "Record the database owner, backup retention, recovery point and recovery time requirements.",
            "Verify a restore and record rollback compatibility with the selected schema release before Production admission.",
          ],
      status: persistenceStatus,
    },
    configuration: {
      databaseEnvironment: generated?.runtime.databaseEnvironment ?? null,
      requiredEvidence: [
        "Verify the intended Production identity, authentication origin, Gateway routes and required runtime configuration without exposing secrets.",
        "Read back the selected provider bindings and verify that application processes receive only authorized runtime credentials.",
      ],
      routes: description?.app.routes ?? [],
      status: "unassessed" as const,
    },
    migration: {
      observedInstallation:
        evidence.installedRelease.status === "passed"
          ? evidence.installedRelease.observation
          : null,
      requiredEvidence: staticApp
        ? []
        : [
            "Review the selected release's installation or migration plan, data impact and compatibility with the prior release.",
            "Observe the installed release and authenticated schema receipt in the intended Production database after approved preparation.",
          ],
      selectedRelease: generated?.release ?? null,
      status: persistenceStatus,
    },
    nativeInstallerIsolation: nativeInstallerIsolation(backend),
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
  const generatedBackend = backend?.kind === generatedBackendKind ? backend : null;
  const routes = description?.app.routes ?? [];
  const evidence = runtimeEvidence(
    backend,
    input.productBehaviorEvidence ?? [],
    input.installationProof?.appId === input.appId ? input.installationProof : undefined,
  );
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
    evidence,
    nextSteps: [
      "Review this app's source, declared capabilities, and recorded runtime observations.",
      ...(backend?.kind === "static"
        ? []
        : [
            "Verify the selected database's installed release and authenticated schema receipt.",
            "Exercise tenant isolation and durable persistence in Preview.",
          ]),
      "Exercise authenticated product outcomes, denied access and revocation in Preview.",
      "Review the operator checklist and obtain separate approvals for preparation, access grants, provider activation and recovery before semantic read-only Production proof.",
    ],
    operatorChecklist: operatorChecklist(input.appId, description, evidence),
    roles: generatedBackend?.roles ?? [],
    route: routes[0] ?? null,
    routes,
    schemaReceiptPath: generatedBackend?.schemaReceipt?.path ?? null,
    status: "operator-review-required" as const,
  };
};
