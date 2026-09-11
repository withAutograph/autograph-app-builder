import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import {
  isHostedVercelSandboxBackend,
  sandboxBackendPlan,
} from "../sandbox/backend";
import { developmentExecutionArtifactDigest } from "../sandbox/development-toolchain";
import { hostedExecutionArtifactDigest } from "../sandbox/hosted-artifact";
import { configuredToolchainImage } from "../sandbox/toolchain";
import { hasTestCapability } from "../testing/test-capability";
import {
  dependencyCacheReceiptDigest,
  planningOverlayRoot,
} from "./dependency-cache";
import type { ObservedDependencyCache } from "./dependency-cache";
import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { safeSourcePath } from "./source-path";
import type { SourceReceipt } from "./source-receipt";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const appId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const repositoryPath = z
  .string()
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/@:-]+$/u);

export class ExistingApplicationChangesRequiredError extends Error {
  constructor() {
    super(
      "The requested application already exists. Inspect its app-owned source files, then retry target planning with exact replacement contents."
    );
    this.name = "ExistingApplicationChangesRequiredError";
  }
}

export const targetIdentitySchema = z.strictObject({
  appId,
  appSpecPath: repositoryPath,
  baseRoutes: z.tuple([z.string().startsWith("/"), z.string().startsWith("/")]),
  contractPath: repositoryPath,
  kernelSchemaPath: repositoryPath,
  packageName: z.string().regex(/^@autograph\/[a-z][a-z0-9-]*$/u),
  projectName: z.string().regex(/^apps-[a-z][a-z0-9-]*$/u),
  workspacePath: repositoryPath,
});

const appSpecBindingSchema = z.strictObject({
  path: repositoryPath,
  sha256: digest,
});

const targetCreationProposalSchemaForTopology = (topologyOwner: string) =>
  z.strictObject({
    blockers: z.array(z.string()),
    contract: z.strictObject({
      version: z.literal(1),
      appId,
      appSpec: appSpecBindingSchema,
    }),
    futurePath: repositoryPath,
    mutations: z.tuple([]),
    plan: z.strictObject({
      source: z.strictObject({
        workspacePath: repositoryPath,
        runtime: z.literal("nextjs"),
        packageName: z.string().regex(/^@autograph\/[a-z][a-z0-9-]*$/u),
        schema: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("none") }),
          z.strictObject({ kind: z.literal("kernel"), path: repositoryPath }),
        ]),
      }),
      product: z.strictObject({
        owner: z.string().min(1),
        appSpec: appSpecBindingSchema,
        optionalCapabilities: z.strictObject({
          integrations: z.array(appId),
          hostedResources: z.array(appId),
        }),
      }),
      topology: z.strictObject({
        configPath: z.literal(topologyOwner),
        projectName: z.string().regex(/^apps-[a-z][a-z0-9-]*$/u),
        packageName: z.string().regex(/^@autograph\/[a-z][a-z0-9-]*$/u),
        routes: z.array(z.string().startsWith("/")),
        assetRoute: z.string().startsWith("/").optional(),
        currentDigest: digest.optional(),
        proposedDigest: digest.optional(),
      }),
    }),
  });

export const targetCreationProposalSchema =
  targetCreationProposalSchemaForTopology("microfrontends.json");

const iterationChangeSchema = z.strictObject({
  after: z.strictObject({
    mode: z.string().regex(/^[0-7]{3,4}$/u),
    digest,
    content: z.string(),
  }),
  before: z
    .strictObject({ mode: z.string().regex(/^[0-7]{3,4}$/u), digest })
    .optional(),
  path: repositoryPath,
});

const targetIterationProposalSchemaForTopology = (topologyOwner: string) =>
  targetCreationProposalSchemaForTopology(topologyOwner)
    .extend({
      iteration: z.strictObject({
        changes: z.array(iterationChangeSchema).min(1),
        digest,
      }),
      operation: z.literal("iterate-existing-app"),
    })
    .superRefine((proposal, context) => {
      if (
        sha256(JSON.stringify(proposal.iteration.changes)) !==
        proposal.iteration.digest
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["iteration", "digest"],
          message: "The iteration digest does not bind its changes.",
        });
      }
    });

export const targetIterationProposalSchema =
  targetIterationProposalSchemaForTopology("microfrontends.json");

export const targetProposalSchema = z.union([
  targetCreationProposalSchema,
  targetIterationProposalSchema,
]);

function targetProposalSchemaForTopology(topologyOwner: string) {
  if (topologyOwner === "microfrontends.json") {
    return targetProposalSchema;
  }
  return z.union([
    targetCreationProposalSchemaForTopology(topologyOwner),
    targetIterationProposalSchemaForTopology(topologyOwner),
  ]);
}

export type TargetIdentity = z.infer<typeof targetIdentitySchema>;
export type TargetProposal = z.infer<typeof targetProposalSchema>;
export type TargetIterationChange = z.infer<typeof iterationChangeSchema>;

export class ExistingAppChangePreimageError extends Error {
  readonly code = "existing_app_change_preimage_missing" as const;
  readonly rejectedPaths: readonly string[];
  readonly exactAppOwnedPaths: readonly string[];

  constructor(input: {
    rejectedPaths: readonly string[];
    exactAppOwnedPaths: readonly string[];
  }) {
    const repair = {
      code: "existing_app_change_preimage_missing",
      exactAppOwnedPaths: [...input.exactAppOwnedPaths],
      next: "Inspect only the listed exact paths, draft replacements from their returned contents, and retry target planning without resolving or preparing the source again.",
      rejectedPaths: [...input.rejectedPaths],
    } as const;
    super(
      `Existing-app changes require exact source preimages. ${JSON.stringify(repair)}`
    );
    this.name = "ExistingAppChangePreimageError";
    this.rejectedPaths = repair.rejectedPaths;
    this.exactAppOwnedPaths = repair.exactAppOwnedPaths;
  }
}

export function targetContractDigest(
  contract: TargetProposal["contract"]
): string {
  return sha256(JSON.stringify(contract));
}

export const TARGET_COMMAND_TIMEOUT_MS = 30_000;
export const TARGET_PLANNING_MISE_PROFILE = `[settings]
exec_auto_install = false
not_found_auto_install = false
task.run_auto_install = false

[deps]
disable = ["bun"]
`;

export type TargetCommand = "identity" | "planning";
export interface TargetCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type TargetCommandExecutor = (input: {
  command: TargetCommand;
  appId: string;
  planningRoot: string;
  contractPath: string;
  appSpecDigest: string;
}) => Promise<TargetCommandResult>;

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function planningMarker(marker: string, phase: "start" | "finish") {
  if (process.env.APP_BUILDER_EXECUTION_BUNDLE === "local-development") {
    console.info(`[app-builder planning] ${marker} ${phase}`);
  }
}

function parseOutput<T>(
  result: TargetCommandResult,
  schema: z.ZodType<T>,
  label: string
): T {
  const stdout = result.stdout
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replaceAll("\r", "")
    .trim();
  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${label} failed with exit code ${result.exitCode}${diagnostic.length === 0 ? "." : `: ${diagnostic.slice(0, 2000)}`}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`${label} returned an invalid shape.`);
  }
  return validated.data;
}

export function targetExecutionBinding(
  cache: ObservedDependencyCache | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env
) {
  if (hasTestCapability("simulated-target", environment)) {
    return {
      imageDigest: `fixture@sha256:${"1".repeat(64)}`,
      dependencyCacheDigest:
        cache === undefined ? "checkout" : dependencyCacheReceiptDigest(cache),
      fixture: true,
    } as const;
  }
  const imageDigest = configuredToolchainImage(environment);
  if (cache === undefined) {
    return {
      imageDigest: imageDigest ?? "vercel-sandbox",
      dependencyCacheDigest: "checkout",
      fixture: false,
    } as const;
  }
  if (imageDigest === undefined) {
    const backend = sandboxBackendPlan({
      environment,
      fixture: false,
      localImageConfigured: false,
    });
    if (
      backend.kind === "vercel-development" &&
      backend.blockers.length === 0
    ) {
      return {
        imageDigest: developmentExecutionArtifactDigest(environment),
        dependencyCacheDigest: dependencyCacheReceiptDigest(cache),
        fixture: false,
      } as const;
    }
    if (
      isHostedVercelSandboxBackend(backend.kind) &&
      backend.blockers.length === 0
    ) {
      return {
        imageDigest: hostedExecutionArtifactDigest(),
        dependencyCacheDigest: dependencyCacheReceiptDigest(cache),
        fixture: false,
      } as const;
    }
    throw new Error(
      "The immutable sandbox image and offline dependency cache are not ready for target commands."
    );
  }
  return {
    dependencyCacheDigest: dependencyCacheReceiptDigest(cache),
    fixture: false,
    imageDigest,
  } as const;
}

export async function materializePlanningOverlay(input: {
  sandbox: SandboxSession;
  artifactRevision: string;
  appId: string;
  appSpecContent: string;
  appSpecDigest: string;
}) {
  planningMarker("planning-overlay", "start");
  const root = planningOverlayRoot(input.artifactRevision);
  // The overlay is builder-owned scratch state. Recreate it from the current
  // checkout, including files generated since cloning. An inspection manifest
  // is optional diagnostic data, not a prerequisite for repository commands.
  await input.sandbox.removePath({ force: true, path: root, recursive: true });
  await ensureSandboxDirectories(input.sandbox, [
    root,
    `${root}/prototype/${input.appId}`,
    `.app-builder/target-inputs/${input.artifactRevision}`,
  ]);
  // Copy the current writable checkout in one operation. Let the filesystem
  // report a real missing-checkout or copy failure instead of predicting one
  // from a stale or absent inventory.
  const copy = await input.sandbox.run({
    abortSignal: AbortSignal.timeout(TARGET_COMMAND_TIMEOUT_MS),
    command: `cp -R /workspace/repository/. /workspace/${root}/`,
    workingDirectory: "/workspace",
  });
  if (copy.exitCode !== 0) {
    await input.sandbox.removePath({
      force: true,
      path: root,
      recursive: true,
    });
    throw new Error("Prepared source copy into the planning overlay failed.");
  }
  const appSpecPath = `prototype/${input.appId}/app-spec.md`;
  await input.sandbox.writeTextFile({
    content: input.appSpecContent,
    path: `${root}/${appSpecPath}`,
  });
  const contract = {
    appId: input.appId,
    appSpec: { path: appSpecPath, sha256: input.appSpecDigest },
    version: 1,
  } as const;
  const contractPath = `.app-builder/target-inputs/${input.artifactRevision}/app-contract.json`;
  await input.sandbox.writeTextFile({
    content: `${JSON.stringify(contract, null, 2)}\n`,
    path: contractPath,
  });
  await input.sandbox.writeTextFile({
    content: TARGET_PLANNING_MISE_PROFILE,
    path: `${root}/.config/mise/config.app-builder.toml`,
  });
  const result = {
    contractDigest: targetContractDigest(contract),
    contractPath: `/workspace/${contractPath}`,
    planningRoot: `/workspace/${root}`,
  };
  planningMarker("planning-overlay", "finish");
  return result;
}

export function sandboxTargetCommandExecutor(
  sandbox: SandboxSession
): TargetCommandExecutor {
  return async ({
    command,
    appId: requestedAppId,
    planningRoot,
    contractPath,
  }) => {
    const abortSignal = AbortSignal.timeout(TARGET_COMMAND_TIMEOUT_MS);
    const request =
      command === "identity"
        ? {
            command: `bun .config/mise/scripts/repository/app-identity.ts --app ${requestedAppId}`,
            workingDirectory: planningRoot,
          }
        : {
            command: `bun .config/mise/scripts/repository/app-contract.ts --contract ${contractPath} --root ${planningRoot}`,
            workingDirectory: planningRoot,
          };
    const result = await sandbox.run({ ...request, abortSignal });
    if (
      result.exitCode === 0 ||
      !/(?:cannot find module|module_not_found|node_modules|dependencies? (?:are )?missing)/iu.test(
        `${result.stdout}\n${result.stderr}`
      )
    ) {
      return result;
    }

    await sandbox.setNetworkPolicy("allow-all");
    const setup = await sandbox.run({
      abortSignal: AbortSignal.timeout(300_000),
      command:
        "bun install --ignore-scripts --filter @autograph/platform-microfrontends",
      workingDirectory: planningRoot,
    });
    if (setup.exitCode !== 0) {
      return setup;
    }
    return sandbox.run({ ...request, abortSignal });
  };
}

export function fixtureTargetCommandExecutor(): TargetCommandExecutor {
  return async ({ command, appId: requestedAppId, appSpecDigest }) => {
    const identity = {
      appId: requestedAppId,
      appSpecPath: `prototype/${requestedAppId}/app-spec.md`,
      baseRoutes: [`/${requestedAppId}`, `/${requestedAppId}/:path*`],
      contractPath: `apps/${requestedAppId}/app.contract.json`,
      kernelSchemaPath: `apps/${requestedAppId}/schema/${requestedAppId}-schema.json`,
      packageName: `@autograph/${requestedAppId}`,
      projectName: `apps-${requestedAppId}`,
      workspacePath: `apps/${requestedAppId}`,
    };
    if (command === "identity") {
      return { exitCode: 0, stdout: JSON.stringify(identity), stderr: "" };
    }
    const proposal = {
      blockers: [],
      contract: {
        appId: requestedAppId,
        appSpec: { path: identity.appSpecPath, sha256: appSpecDigest },
        version: 1,
      },
      futurePath: identity.contractPath,
      mutations: [],
      plan: {
        product: {
          appSpec: { path: identity.appSpecPath, sha256: appSpecDigest },
          optionalCapabilities: { hostedResources: [], integrations: [] },
          owner: "fixture-owner",
        },
        source: {
          packageName: identity.packageName,
          runtime: "nextjs",
          schema: { kind: "none" },
          workspacePath: identity.workspacePath,
        },
        topology: {
          configPath: "microfrontends.json",
          packageName: identity.packageName,
          projectName: identity.projectName,
          routes: identity.baseRoutes,
        },
      },
    };
    return { exitCode: 0, stderr: "", stdout: JSON.stringify(proposal) };
  };
}

export async function executeTargetIdentityAndPlanning(input: {
  sandbox: SandboxSession;
  executor: TargetCommandExecutor;
  appId: string;
  appSpecContent: string;
  appSpecDigest: string;
  artifactRevision: string;
  existingAppChanges?: readonly { path: string; content: string }[];
  sourceReceipt?: SourceReceipt;
  environment?: Readonly<Record<string, string | undefined>>;
  onIdentity?: (identity: TargetIdentity) => void | Promise<void>;
}) {
  planningMarker("target-identity-and-planning", "start");
  const overlay = await materializePlanningOverlay(input);
  const identity = parseOutput(
    await input.executor({
      appId: input.appId,
      appSpecDigest: input.appSpecDigest,
      command: "identity",
      ...overlay,
    }),
    targetIdentitySchema,
    "Target identity command"
  );
  const expectedIdentity = {
    appId: input.appId,
    appSpecPath: `prototype/${input.appId}/app-spec.md`,
    baseRoutes: [`/${input.appId}`, `/${input.appId}/:path*`],
    contractPath: `apps/${input.appId}/app.contract.json`,
    kernelSchemaPath: `apps/${input.appId}/schema/${input.appId}-schema.json`,
    packageName: `@autograph/${input.appId}`,
    projectName: `apps-${input.appId}`,
    workspacePath: `apps/${input.appId}`,
  };
  if (JSON.stringify(identity) !== JSON.stringify(expectedIdentity)) {
    throw new Error("Target identity did not match the accepted AppSpec.");
  }
  // Discover the actual prepared checkout. Authored changes may describe a
  // new app, and existing apps do not need a package manifest to be iterable.
  const existingApplication =
    (
      await input.sandbox.run({
        command: `test -d /workspace/repository/${identity.workspacePath}`,
      })
    ).exitCode === 0;
  if (existingApplication && input.existingAppChanges === undefined) {
    throw new ExistingApplicationChangesRequiredError();
  }
  if (existingApplication && input.existingAppChanges !== undefined) {
    const seen = new Set<string>();
    const changes: TargetIterationChange[] = [];
    for (const requested of input.existingAppChanges) {
      if (
        !safeSourcePath(requested.path) ||
        !requested.path.startsWith(`${identity.workspacePath}/`) ||
        requested.path === identity.contractPath ||
        seen.has(requested.path)
      ) {
        throw new Error("An existing-app change path is not allowed.");
      }
      seen.add(requested.path);
      const before = await input.sandbox.readBinaryFile({
        path: `repository/${requested.path}`,
      });
      const observedMode =
        before === null
          ? undefined
          : await input.sandbox.run({
              command: `stat -c %a /workspace/repository/${requested.path}`,
            });
      const mode =
        observedMode?.exitCode === 0 &&
        /^[0-7]{3,4}$/u.test(observedMode.stdout.trim())
          ? observedMode.stdout.trim()
          : "644";
      changes.push({
        path: requested.path,
        ...(before === null
          ? {}
          : { before: { digest: sha256(before), mode } }),
        after: {
          content: requested.content,
          digest: sha256(requested.content),
          mode,
        },
      });
    }
    if (changes.length === 0) {
      throw new Error("At least one existing-app change is required.");
    }
    const contract = {
      appId: input.appId,
      appSpec: {
        path: identity.appSpecPath,
        sha256: input.appSpecDigest,
      },
      version: 1 as const,
    };
    const iterationDigest = sha256(JSON.stringify(changes));
    await input.onIdentity?.(identity);
    const proposal = targetIterationProposalSchemaForTopology(
      "microfrontends.json"
    ).parse({
      blockers: [],
      contract,
      futurePath: identity.contractPath,
      iteration: { changes, digest: iterationDigest },
      mutations: [],
      operation: "iterate-existing-app",
      plan: {
        product: {
          appSpec: contract.appSpec,
          optionalCapabilities: { hostedResources: [], integrations: [] },
          owner: "existing-application-owner",
        },
        source: {
          packageName: identity.packageName,
          runtime: "nextjs",
          schema: { kind: "none" },
          workspacePath: identity.workspacePath,
        },
        topology: {
          configPath: "microfrontends.json",
          packageName: identity.packageName,
          projectName: identity.projectName,
          routes: identity.baseRoutes,
        },
      },
    }) as unknown as TargetProposal;
    const result = { identity, proposal, ...overlay };
    planningMarker("target-identity-and-planning", "finish");
    return result;
  }
  await input.onIdentity?.(identity);
  const proposal = parseOutput<TargetProposal>(
    await input.executor({
      appId: input.appId,
      appSpecDigest: input.appSpecDigest,
      command: "planning",
      ...overlay,
    }),
    targetProposalSchemaForTopology(
      "microfrontends.json"
    ) as unknown as z.ZodType<TargetProposal>,
    "Target planning command"
  );
  if (
    proposal.contract.appId !== input.appId ||
    proposal.contract.appSpec.path !== identity.appSpecPath ||
    proposal.contract.appSpec.sha256 !== input.appSpecDigest ||
    proposal.futurePath !== identity.contractPath ||
    proposal.plan.source.workspacePath !== identity.workspacePath ||
    proposal.plan.source.packageName !== identity.packageName ||
    proposal.plan.topology.projectName !== identity.projectName ||
    proposal.plan.topology.packageName !== identity.packageName
  ) {
    throw new Error("Target proposal did not match the resolved identity.");
  }
  const result = { identity, proposal, ...overlay };
  planningMarker("target-identity-and-planning", "finish");
  return result;
}
