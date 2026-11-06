import {
  applicationSourceRegistrationSchema,
  planApplicationSourceRegistration,
} from "./application-source-registration";
import { privateComputeProfileSchema } from "../sandbox/private-compute-profile";
import type { PrivateComputeProfile } from "../sandbox/private-compute-profile";
import { localSourceReconciliationSchema } from "./local-source-reconciliation-contract";
import type { LocalSourceReconciliation } from "./local-source-reconciliation-contract";
import { canAutoSelectDevelopmentSource } from "./development-source";
import {
  frameworkUpgradeSchema,
  planFrameworkUpgrade,
  resolveLatestFrameworkVersions,
} from "./framework-upgrade";
import type { FrameworkVersions } from "./framework-upgrade";
import { setBuilderSandboxNetworkPolicy } from "../sandbox/builder-sandbox";
import { describeSelectedApp } from "./app-description";
import { createHash } from "node:crypto";

import { z } from "zod";

import type { SandboxSession } from "eve/sandbox";
import { hasTestCapability } from "../testing/test-capability";

import { ensureSandboxDirectories } from "./sandbox-filesystem";

import { dependencyCacheReceiptDigest, planningOverlayRoot } from "./dependency-cache";
import type { ObservedDependencyCache } from "./dependency-cache";
import { configuredToolchainImage } from "../sandbox/toolchain";
import { isHostedVercelSandboxBackend, sandboxBackendPlan } from "../sandbox/backend";
import { developmentExecutionArtifactDigest } from "../sandbox/development-toolchain";
import { hostedExecutionArtifactDigest } from "../sandbox/hosted-artifact";
import type { SourceReceipt } from "./source-receipt";
import { ExistingApplicationChangesRequiredError } from "./target-planning-errors";
import type { ApplicationFileChange } from "./application-file-change";
import { applicationFilePathSchema } from "./application-file-change";

export {
  ExistingApplicationChangesRequiredError,
  ExistingAppChangePreimageError,
} from "./target-planning-errors";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const appId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const repositoryPath = z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/@:-]+$/u);
const shellArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const repositoryPathPrefix = (root: string) => [root, ""].join("/");
const privateComputeCheckPath = (id: string) => `apps/${id}/.config/mise/tasks/check`;
const repositoryWorkingDirectory = "/workspace/repository";
const targetPlanningMarker = "target-identity-and-planning";
const exactAppContractMessage = "must belong to the exact app contract.";
const appIdentityTask = "app-identity.ts";
const microfrontendsConfig = "microfrontends.json";
const sourceImportManifestDigestPattern = /^[a-f0-9]{64}$/u;
const hasPlanningOptions = (value: {
  frameworkUpgrade?: unknown;
  sourceReconciliation?: unknown;
  privateCompute?: unknown;
  applicationSourceImport?: unknown;
}) =>
  value.frameworkUpgrade !== undefined ||
  value.sourceReconciliation !== undefined ||
  value.privateCompute !== undefined ||
  value.applicationSourceImport !== undefined;
// Project only identity fields consumed here; producer metadata grants no authority.
export const targetIdentitySchema = z.object({
  appId,
  appSpecPath: repositoryPath,
  appSpecSourcePath: repositoryPath,
  baseRoutes: z.tuple([z.string().startsWith("/")]).rest(z.string().startsWith("/")),
  cueSourcePath: repositoryPath,
  packageName: z.string().min(1),
  projectName: appId,
  schemaCuePath: repositoryPath,
  title: z.string().min(1),
  workspacePath: repositoryPath,
});

const appSpecBindingSchema = z.strictObject({
  path: repositoryPath,
  sha256: digest,
});

// Persisted creation state can contain retired metadata. Parse only the current
// fields without rewriting the stored receipt or its digest on resume.
const targetCreationProposalSchemaForTopology = (topologyOwner: string) =>
  z
    .strictObject({
      blockers: z.array(z.string()),
      contract: z.strictObject({
        appId,
        appSpec: appSpecBindingSchema,
        version: z.literal(1),
      }),
      frameworkUpgrade: frameworkUpgradeSchema.optional(),
      mutations: z.tuple([]),
      plan: z.strictObject({
        product: z.strictObject({
          appSpec: appSpecBindingSchema,
        }),
        source: z.strictObject({
          packageName: z.string().min(1),
          runtime: z.literal("nextjs"),
          schema: z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("none") }),
            z.strictObject({ kind: z.literal("kernel"), path: repositoryPath }),
          ]),
          workspacePath: repositoryPath,
        }),
        topology: z.strictObject({
          assetRoute: z.string().startsWith("/").optional(),
          configPath: z.literal(topologyOwner),
          currentDigest: digest.optional(),
          packageName: z.string().min(1),
          projectName: appId,
          proposedDigest: digest.optional(),
          routes: z.array(z.string().startsWith("/")),
        }),
      }),
      privateCompute: privateComputeProfileSchema.optional(),
    })
    .superRefine((proposal, context) => {
      if (
        proposal.privateCompute !== undefined &&
        proposal.privateCompute.checkPolicy.path !==
          privateComputeCheckPath(proposal.contract.appId)
      ) {
        context.addIssue({
          code: "custom",
          message: `The compute check policy ${exactAppContractMessage}`,
        });
      }
    });

export const targetCreationProposalSchema =
  targetCreationProposalSchemaForTopology("microfrontends.json");

const iterationChangeSchema = z
  .strictObject({
    after: z
      .strictObject({
        content: z.string(),
        digest,
        mode: z.string().regex(/^[0-7]{3,4}$/u),
      })
      .optional(),
    before: z
      .strictObject({
        digest,
        mode: z.string().regex(/^[0-7]{3,4}$/u),
      })
      .optional(),
    path: applicationFilePathSchema,
  })
  .superRefine((change, context) => {
    if (change.after === undefined && change.before === undefined) {
      context.addIssue({
        code: "custom",
        message: "Deleting a file requires its observed preimage.",
      });
    }
  });

const applicationSourceImportPlanningSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  importedSessionId: z.string().min(1),
  manifestDigest: z.string().regex(sourceImportManifestDigestPattern),
  registration: applicationSourceRegistrationSchema.optional(),
});

const isSourceReconciliationForAnotherContract = (proposal: {
  sourceReconciliation?: LocalSourceReconciliation;
  contract: { appId: string; appSpec: { sha256: string } };
}) => {
  const reconciliation = proposal.sourceReconciliation;
  return (
    reconciliation !== undefined &&
    (reconciliation.appId !== proposal.contract.appId ||
      reconciliation.appSpecDigest !== proposal.contract.appSpec.sha256)
  );
};

const targetIterationProposalSchemaForTopology = (topologyOwner: string) =>
  targetCreationProposalSchemaForTopology(topologyOwner)
    .safeExtend({
      applicationSourceImport: applicationSourceImportPlanningSchema.optional(),
      iteration: z.strictObject({
        changes: z.array(iterationChangeSchema),
        digest,
      }),
      operation: z.literal("iterate-existing-app"),
      sourceReconciliation: localSourceReconciliationSchema.optional(),
    })
    .superRefine((proposal, context) => {
      if (proposal.iteration.changes.length === 0 && !hasPlanningOptions(proposal)) {
        context.addIssue({
          code: "custom",
          message: "An existing-app iteration requires app changes or a framework upgrade",
        });
      }
      if (
        proposal.applicationSourceImport !== undefined &&
        proposal.applicationSourceImport.registration === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "The imported app requires its platform registration plan.",
          path: ["applicationSourceImport"],
        });
      }
      if (
        proposal.applicationSourceImport !== undefined &&
        proposal.applicationSourceImport.appId !== proposal.contract.appId
      ) {
        context.addIssue({
          code: "custom",
          message: "The application source import belongs to another app.",
          path: ["applicationSourceImport"],
        });
      }
      if (isSourceReconciliationForAnotherContract(proposal)) {
        context.addIssue({
          code: "custom",
          message: "Local source reconciliation must retain its exact app and accepted product.",
        });
      }
      if (sha256(JSON.stringify(proposal.iteration.changes)) !== proposal.iteration.digest) {
        context.addIssue({
          code: "custom",
          message: "The iteration digest does not bind its changes.",
          path: ["iteration", "digest"],
        });
      }
    });

export const targetIterationProposalSchema =
  targetIterationProposalSchemaForTopology(microfrontendsConfig);

export const targetProposalSchema = z.preprocess(
  (input) => {
    const legacy = z
      .looseObject({
        futurePath: z.string(),
        plan: z.looseObject({ product: z.record(z.string(), z.unknown()) }),
      })
      .safeParse(input);
    if (!legacy.success) {
      return input;
    }
    const normalizedPlan = {
      ...legacy.data.plan,
      product: Object.fromEntries(
        Object.entries(legacy.data.plan.product).filter(
          ([key]) => key !== "owner" && key !== "optionalCapabilities",
        ),
      ),
    };
    return {
      ...Object.fromEntries(Object.entries(legacy.data).filter(([key]) => key !== "futurePath")),
      plan: normalizedPlan,
    };
  },
  z.union([targetCreationProposalSchema, targetIterationProposalSchema]),
);

export type TargetIdentity = z.infer<typeof targetIdentitySchema>;
export type TargetProposal = z.infer<typeof targetProposalSchema>;
export type TargetIterationChange = z.infer<typeof iterationChangeSchema>;

export const targetContractDigest = (contract: TargetProposal["contract"]): string =>
  sha256(JSON.stringify(contract));

export type TargetCommand = "identity";
export interface TargetCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type TargetCommandExecutor = (input: {
  command: TargetCommand;
  appId: string;
  planningRoot: string;
  appSpecDigest: string;
}) => Promise<TargetCommandResult>;

const planningMarker = (marker: string, phase: "start" | "finish") => {
  if (process.env.APP_BUILDER_EXECUTION_BUNDLE === "local-development") {
    console.info(`[app-builder planning] ${marker} ${phase}`);
  }
};

const planningFailureDetail = (value: string): string =>
  value
    .replaceAll(/https?:\/\/[^\s]+/giu, "[URL REDACTED]")
    .replaceAll(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replaceAll(
      /\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/gu,
      "[REDACTED]",
    )
    .replaceAll(
      /\b(?<key>authorization|cookie|password|passwd|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$<key>=[REDACTED]",
    )
    .replaceAll(/\s+/gu, " ")
    .trim();

const formatValidationIssues = (issues: readonly z.core.$ZodIssue[]) =>
  issues.map((issue) => [issue.path.join(".") || "result", issue.message].join(": ")).join("; ");

const parseOutput = <T>(result: TargetCommandResult, schema: z.ZodType<T>, label: string): T => {
  const stdout = result.stdout
    .replaceAll(new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "gu"), "")
    .replaceAll("\r", "")
    .trim();
  if (result.exitCode !== 0) {
    const diagnostic = planningFailureDetail(result.stderr || result.stdout);
    throw new Error(
      `${label} failed with exit code ${result.exitCode}. Check the named repository task and its dependencies, then retry planning. Cause: ${diagnostic || "The command returned no diagnostic output."}`,
    );
  }
  let parsed: unknown;
  try {
    // SAFETY: JSON.parse yields an untrusted value; keeping it unknown prevents use before schema validation.
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON. Check that the repository task writes one JSON result to stdout and diagnostics to stderr, then retry planning. Cause: ${planningFailureDetail(error instanceof Error ? error.message : String(error))}`,
      { cause: error },
    );
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `${label} returned JSON that does not match Builder's expected result. Check the repository task output contract, then retry planning. Cause: ${planningFailureDetail(formatValidationIssues(validated.error.issues))}`,
    );
  }
  return validated.data;
};

export const targetExecutionBinding = (
  cache: ObservedDependencyCache | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  if (hasTestCapability("simulated-target", environment)) {
    return {
      dependencyCacheDigest: cache === undefined ? "checkout" : dependencyCacheReceiptDigest(cache),
      fixture: true,
      imageDigest: `fixture@sha256:${"1".repeat(64)}`,
    } as const;
  }
  const imageDigest = configuredToolchainImage(environment);
  if (cache === undefined) {
    return {
      dependencyCacheDigest: "checkout",
      fixture: false,
      imageDigest: imageDigest ?? "vercel-sandbox",
    } as const;
  }
  if (imageDigest === undefined) {
    const backend = sandboxBackendPlan({
      environment,
      fixture: false,
      localImageConfigured: false,
    });
    if (backend.kind === "vercel-development" && backend.blockers.length === 0) {
      return {
        dependencyCacheDigest: dependencyCacheReceiptDigest(cache),
        fixture: false,
        imageDigest: developmentExecutionArtifactDigest(environment),
      } as const;
    }
    if (isHostedVercelSandboxBackend(backend.kind) && backend.blockers.length === 0) {
      return {
        dependencyCacheDigest: dependencyCacheReceiptDigest(cache),
        fixture: false,
        imageDigest: hostedExecutionArtifactDigest(),
      } as const;
    }
    throw new Error(
      "The immutable sandbox image and offline dependency cache are not ready for target commands.",
    );
  }
  return {
    dependencyCacheDigest: dependencyCacheReceiptDigest(cache),
    fixture: false,
    imageDigest,
  } as const;
};

export const materializePlanningOverlay = async (input: {
  sandbox: SandboxSession;
  artifactRevision: string;
  appId: string;
  appSpecContent?: string;
  appSpecStream?: ReadableStream<Uint8Array>;
  appSpecDigest: string;
}) => {
  planningMarker("planning-overlay", "start");
  const root = planningOverlayRoot(input.artifactRevision);
  // Retain accepted planning input outside the live checkout. Identity and
  // source inspection use current repository bytes without copying its tree.
  await input.sandbox.removePath({ force: true, path: root, recursive: true });
  await ensureSandboxDirectories(input.sandbox, [root, `${root}/prototype/${input.appId}`]);
  const appSpecPath = ["prototype", input.appId, "app-spec.md"].join("/");
  if (input.appSpecStream === undefined) {
    if (input.appSpecContent === undefined) {
      throw new Error("The accepted AppSpec content or stream is unavailable for planning.");
    }
    await input.sandbox.writeTextFile({
      content: input.appSpecContent,
      path: `${root}/${appSpecPath}`,
    });
  } else {
    await input.sandbox.writeFile({
      content: input.appSpecStream,
      path: `${root}/${appSpecPath}`,
    });
  }
  const contract = {
    appId: input.appId,
    appSpec: { path: appSpecPath, sha256: input.appSpecDigest },
    version: 1,
  } as const;
  const result = {
    contractDigest: targetContractDigest(contract),
    planningRoot: `/workspace/${root}`,
  };
  planningMarker("planning-overlay", "finish");
  return result;
};

export const sandboxTargetCommandExecutor =
  (sandbox: SandboxSession): TargetCommandExecutor =>
  async ({ appId: requestedAppId }) => {
    // planningRoot retains accepted input; repository commands read live source.
    const request = {
      command: `mise run --no-deps repository:exec -- ${appIdentityTask} --app ${requestedAppId}`,
      env: {
        MISE_EXEC_AUTO_INSTALL: "false",
        MISE_NOT_FOUND_AUTO_INSTALL: "false",
        MISE_TASK_RUN_AUTO_INSTALL: "false",
      },
      workingDirectory: repositoryWorkingDirectory,
    };
    const result = await sandbox.run(request);
    if (
      result.exitCode === 0 ||
      !/(?:cannot find module|module_not_found|node_modules|dependencies? (?:are )?missing)/iu.test(
        `${result.stdout}\n${result.stderr}`,
      )
    ) {
      return result;
    }

    await setBuilderSandboxNetworkPolicy(sandbox, "allow-all");
    const setup = await sandbox.run({
      command: "bun install --ignore-scripts --filter @autograph/platform-microfrontends",
      workingDirectory: "/workspace/repository",
    });
    if (setup.exitCode !== 0) {
      return setup;
    }
    return await sandbox.run(request);
  };

const creationPlan = (
  identity: TargetIdentity,
  appSpecDigest: string,
  cue: boolean,
): TargetProposal => ({
  blockers: [],
  contract: {
    appId: identity.appId,
    appSpec: { path: `prototype/${identity.appId}/app-spec.md`, sha256: appSpecDigest },
    version: 1,
  },
  mutations: [],
  plan: {
    product: {
      appSpec: { path: `prototype/${identity.appId}/app-spec.md`, sha256: appSpecDigest },
    },
    source: {
      packageName: identity.packageName,
      runtime: "nextjs",
      schema: cue ? { kind: "kernel", path: identity.schemaCuePath } : { kind: "none" },
      workspacePath: identity.workspacePath,
    },
    topology: {
      assetRoute: `/${identity.appId}/_next/:path*`,
      configPath: microfrontendsConfig,
      packageName: identity.packageName,
      projectName: identity.projectName,
      routes: identity.baseRoutes,
    },
  },
});

const conventionalIdentity = (requestedAppId: string): TargetIdentity => ({
  appId: requestedAppId,
  appSpecPath: `apps/${requestedAppId}/.config/app-spec.md`,
  appSpecSourcePath: `.config/app-specs/${requestedAppId}.md`,
  baseRoutes: [`/${requestedAppId}`, `/${requestedAppId}/:path*`],
  cueSourcePath: `.config/app-specs/${requestedAppId}.cue`,
  packageName: `@autograph/${requestedAppId}`,
  projectName: `apps-${requestedAppId}`,
  schemaCuePath: `apps/${requestedAppId}/schema/${requestedAppId}.cue`,
  title: requestedAppId
    .split("-")
    .map((part) => (part[0]?.toUpperCase() ?? "") + part.slice(1))
    .join(" "),
  workspacePath: `apps/${requestedAppId}`,
});

export const fixtureTargetCommandExecutor =
  (): TargetCommandExecutor =>
  async ({ appId: requestedAppId }) => ({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify(conventionalIdentity(requestedAppId)),
  });

interface RequestedPlanningFeatures {
  frameworkUpgrade?: FrameworkVersions;
  sourceReconciliation?: LocalSourceReconciliation;
  privateCompute?: PrivateComputeProfile;
  applicationSourceImport?: z.infer<typeof applicationSourceImportPlanningSchema>;
}

const requestedFeatureExists = (features: RequestedPlanningFeatures) =>
  Object.values(features).some((feature) => feature !== undefined);

const hasRequestedPlanningFeatures = (
  applicationSourceImport: RequestedPlanningFeatures["applicationSourceImport"],
  frameworkUpgrade: FrameworkVersions | undefined,
  privateCompute: PrivateComputeProfile | undefined,
  sourceReconciliation: LocalSourceReconciliation | undefined,
) =>
  requestedFeatureExists({
    applicationSourceImport,
    frameworkUpgrade,
    privateCompute,
    sourceReconciliation,
  });

const schemaExistsForPlan = (
  plannedImport: Awaited<ReturnType<typeof planSourceImport>>,
  generatedPostgres: boolean,
  importedFileExists: boolean,
) => (plannedImport === undefined ? generatedPostgres : importedFileExists);

const addCreationOptions = (
  proposal: ReturnType<typeof creationPlan>,
  frameworkUpgrade: FrameworkVersions | undefined,
  privateCompute: PrivateComputeProfile | undefined,
) => {
  if (privateCompute !== undefined) {
    proposal.privateCompute = privateCompute;
  }
  if (frameworkUpgrade !== undefined) {
    proposal.frameworkUpgrade = frameworkUpgrade;
  }
};

const validateExistingChangePaths = (
  requestedChanges: readonly ApplicationFileChange[],
  identity: TargetIdentity,
  seen: Set<string>,
) => {
  for (const requested of requestedChanges) {
    const invalidPath = !applicationFilePathSchema.safeParse(requested.path).success;
    const outsideWorkspace = !requested.path.startsWith(
      repositoryPathPrefix(identity.workspacePath),
    );
    const changesAppSpec = requested.path === identity.appSpecPath;
    const duplicatePath = seen.has(requested.path);
    if (invalidPath || outsideWorkspace || changesAppSpec || duplicatePath) {
      throw new Error("An existing-app change path is not allowed.");
    }
    seen.add(requested.path);
  }
};

const planSourceImport = async (
  sandbox: SandboxSession,
  requestedAppId: string,
  applicationSourceImport: RequestedPlanningFeatures["applicationSourceImport"],
): Promise<
  Awaited<ReturnType<typeof planApplicationSourceRegistration>> extends infer _Registration
    ?
        | (RequestedPlanningFeatures["applicationSourceImport"] & {
            registration: NonNullable<
              RequestedPlanningFeatures["applicationSourceImport"]
            >["registration"];
          })
        | undefined
    : never
> => {
  if (applicationSourceImport === undefined) {
    return undefined;
  }
  const registration = await planApplicationSourceRegistration(sandbox, requestedAppId);
  return { ...applicationSourceImport, registration };
};

const addPlanningOptions = (
  proposal: ReturnType<typeof creationPlan> & {
    iteration: { changes: TargetIterationChange[]; digest: string };
    operation: "iterate-existing-app";
    applicationSourceImport?: Awaited<ReturnType<typeof planSourceImport>>;
    sourceReconciliation?: LocalSourceReconciliation;
  },
  options: RequestedPlanningFeatures,
) => {
  if (options.frameworkUpgrade !== undefined) {
    proposal.frameworkUpgrade = options.frameworkUpgrade;
  }
  if (options.applicationSourceImport !== undefined) {
    proposal.applicationSourceImport = options.applicationSourceImport;
  }
  if (options.sourceReconciliation !== undefined) {
    proposal.sourceReconciliation = options.sourceReconciliation;
  }
  if (options.privateCompute !== undefined) {
    proposal.privateCompute = options.privateCompute;
  }
};

const validObservedMode = (exitCode: number | undefined, mode: string | undefined) =>
  exitCode === 0 && mode !== undefined && /^[0-7]{3,4}$/u.test(mode);

const readExistingChange = async (
  sandbox: SandboxSession,
  requested: ApplicationFileChange,
): Promise<TargetIterationChange | undefined> => {
  const before = await sandbox.readBinaryFile({ path: `repository/${requested.path}` });
  const observedMode =
    before === null
      ? undefined
      : await sandbox.run({
          command: `stat -c %a -- ${shellArgument([repositoryWorkingDirectory, requested.path].join("/"))}`,
        });
  const rawMode = observedMode?.stdout.trim();
  const mode = validObservedMode(observedMode?.exitCode, rawMode) ? rawMode : "644";
  if (requested.operation === "delete" && before === null) {
    return undefined;
  }
  const change: TargetIterationChange = { path: requested.path };
  if (requested.operation !== "delete") {
    change.after = { content: requested.content, digest: sha256(requested.content), mode };
  }
  if (before !== null) {
    change.before = { digest: sha256(before), mode };
  }
  return change;
};

const planExistingApplication = async (
  input: Parameters<typeof executeTargetIdentityAndPlanning>[0],
  identity: TargetIdentity,
  overlay: Awaited<ReturnType<typeof materializePlanningOverlay>>,
  frameworkUpgrade: FrameworkVersions | undefined,
  sourceReconciliation: LocalSourceReconciliation | undefined,
  privateCompute: PrivateComputeProfile | undefined,
  applicationSourceImport: z.infer<typeof applicationSourceImportPlanningSchema> | undefined,
) => {
  const requestedChanges = input.existingAppChanges ?? [];
  const seen = new Set<string>();
  validateExistingChangePaths(requestedChanges, identity, seen);
  const observedChanges = await Promise.all(
    requestedChanges.map(async (requested) => await readExistingChange(input.sandbox, requested)),
  );
  const changes = observedChanges.filter(
    (change): change is TargetIterationChange => change !== undefined,
  );
  if (
    changes.length === 0 &&
    !hasRequestedPlanningFeatures(
      applicationSourceImport,
      frameworkUpgrade,
      privateCompute,
      sourceReconciliation,
    )
  ) {
    throw new Error("At least one existing-app change is required.");
  }
  await input.onIdentity?.(identity);
  const schemaChange = requestedChanges.find((change) => change.path === identity.schemaCuePath);
  const plannedApplicationSourceImport = await planSourceImport(
    input.sandbox,
    input.appId,
    applicationSourceImport,
  );
  const importedSchema =
    plannedApplicationSourceImport === undefined
      ? undefined
      : await input.sandbox.run({
          command: ["test -f", `${repositoryWorkingDirectory}/${identity.schemaCuePath}`].join(" "),
          workingDirectory: repositoryWorkingDirectory,
        });
  const description =
    schemaChange === undefined && plannedApplicationSourceImport === undefined
      ? await describeSelectedApp({
          appId: identity.appId,
          root: repositoryWorkingDirectory,
          sandbox: input.sandbox,
        })
      : undefined;
  let hasSchema = schemaExistsForPlan(
    plannedApplicationSourceImport,
    description?.backend.kind === "generated-postgres",
    importedSchema?.exitCode === 0,
  );
  if (schemaChange !== undefined) {
    hasSchema = schemaChange.operation !== "delete";
  }
  const proposalInput = {
    ...creationPlan(identity, input.appSpecDigest, hasSchema),
    iteration: { changes, digest: sha256(JSON.stringify(changes)) },
    operation: "iterate-existing-app" as const,
  };
  addPlanningOptions(proposalInput, {
    applicationSourceImport: plannedApplicationSourceImport,
    frameworkUpgrade,
    privateCompute,
    sourceReconciliation,
  });
  const proposal =
    targetIterationProposalSchemaForTopology(microfrontendsConfig).parse(proposalInput);
  return { identity, proposal, ...overlay };
};

const planNewApplication = async (
  input: Parameters<typeof executeTargetIdentityAndPlanning>[0],
  identity: TargetIdentity,
  overlay: Awaited<ReturnType<typeof materializePlanningOverlay>>,
  frameworkUpgrade: FrameworkVersions | undefined,
  privateCompute: PrivateComputeProfile | undefined,
) => {
  await input.onIdentity?.(identity);
  const cue = await input.sandbox.run({
    command: `test -f ${identity.cueSourcePath}`,
    workingDirectory: repositoryWorkingDirectory,
  });
  const proposal = creationPlan(identity, input.appSpecDigest, cue.exitCode === 0);
  addCreationOptions(proposal, frameworkUpgrade, privateCompute);
  return { identity, proposal, ...overlay };
};

export const executeTargetIdentityAndPlanning = async (input: {
  sandbox: SandboxSession;
  executor: TargetCommandExecutor;
  appId: string;
  appSpecContent?: string;
  appSpecStream?: ReadableStream<Uint8Array>;
  appSpecDigest: string;
  artifactRevision: string;
  existingAppChanges?: readonly ApplicationFileChange[];
  localSourceReconciliation?: LocalSourceReconciliation;
  applicationSourceImport?: z.infer<typeof applicationSourceImportPlanningSchema>;
  privateCompute?: PrivateComputeProfile;
  frameworkUpgradeRequested?: boolean;
  resolveFrameworkVersions?: () => Promise<FrameworkVersions>;
  sourceReceipt?: SourceReceipt;
  environment?: Readonly<Record<string, string | undefined>>;
  onIdentity?: (identity: TargetIdentity) => void | Promise<void>;
}) => {
  planningMarker(targetPlanningMarker, "start");
  const privateCompute =
    input.privateCompute === undefined
      ? undefined
      : privateComputeProfileSchema.parse(input.privateCompute);
  if (
    privateCompute !== undefined &&
    privateCompute.checkPolicy.path !== privateComputeCheckPath(input.appId)
  ) {
    throw new Error("The private compute check policy belongs to another app.");
  }
  const applicationSourceImport =
    input.applicationSourceImport === undefined
      ? undefined
      : applicationSourceImportPlanningSchema.parse(input.applicationSourceImport);
  if (applicationSourceImport !== undefined && applicationSourceImport.appId !== input.appId) {
    throw new Error("The imported app identity must be preserved.");
  }
  const sourceReconciliation =
    input.localSourceReconciliation === undefined
      ? undefined
      : localSourceReconciliationSchema.parse(input.localSourceReconciliation);
  const sourceReconciliationInvalid =
    sourceReconciliation !== undefined &&
    [
      !canAutoSelectDevelopmentSource(input.environment),
      sourceReconciliation.appId !== input.appId,
      sourceReconciliation.appSpecDigest !== input.appSpecDigest,
      sourceReconciliation.sourceReceiptDigest !== input.sourceReceipt?.digest,
    ].some(Boolean);
  if (sourceReconciliationInvalid) {
    throw new Error("Local source reconciliation does not belong to this planning input.");
  }
  const overlay = await materializePlanningOverlay(input);
  const identity = parseOutput(
    await input.executor({
      appId: input.appId,
      appSpecDigest: input.appSpecDigest,
      command: "identity",
      ...overlay,
    }),
    targetIdentitySchema,
    "Target identity command",
  );
  // The repository owns app metadata and layout; only the selected app id
  // binds this command result to the requested application.
  if (identity.appId !== input.appId) {
    throw new Error("Target identity did not match the accepted app id.");
  }
  // Discover the actual prepared checkout. Authored changes may describe a
  // new app, and existing apps do not need a package manifest to be iterable.
  const existingApplicationResult = await input.sandbox.run({
    command: `test -d ${repositoryWorkingDirectory}/${identity.workspacePath}`,
  });
  const existingApplication = existingApplicationResult.exitCode === 0;
  const frameworkUpgradeRequested =
    input.frameworkUpgradeRequested === true ||
    (!existingApplication && input.resolveFrameworkVersions !== undefined);
  const frameworkUpgrade = frameworkUpgradeRequested
    ? await planFrameworkUpgrade(
        input.sandbox,
        await (input.resolveFrameworkVersions ?? resolveLatestFrameworkVersions)(),
      )
    : undefined;
  if (
    existingApplication &&
    input.existingAppChanges === undefined &&
    !requestedFeatureExists({
      applicationSourceImport,
      frameworkUpgrade,
      privateCompute,
      sourceReconciliation,
    })
  ) {
    throw new ExistingApplicationChangesRequiredError();
  }
  if (existingApplication) {
    const result = await planExistingApplication(
      input,
      identity,
      overlay,
      frameworkUpgrade,
      sourceReconciliation,
      privateCompute,
      applicationSourceImport,
    );
    planningMarker(targetPlanningMarker, "finish");
    return result;
  }
  const result = await planNewApplication(
    input,
    identity,
    overlay,
    frameworkUpgrade,
    privateCompute,
  );
  planningMarker(targetPlanningMarker, "finish");
  return result;
};
