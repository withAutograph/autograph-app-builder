import { createHash } from "node:crypto";

import { z } from "zod";

import type { SandboxSession } from "eve/sandbox";
import { hasTestCapability } from "../testing/test-capability";

import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { safeSourcePath } from "./source-path";

import { dependencyCacheReceiptDigest, planningOverlayRoot } from "./dependency-cache";
import type { ObservedDependencyCache } from "./dependency-cache";
import { configuredToolchainImage } from "../sandbox/toolchain";
import { isHostedVercelSandboxBackend, sandboxBackendPlan } from "../sandbox/backend";
import { developmentExecutionArtifactDigest } from "../sandbox/development-toolchain";
import { hostedExecutionArtifactDigest } from "../sandbox/hosted-artifact";
import type { SourceReceipt } from "./source-receipt";
import { ExistingApplicationChangesRequiredError } from "./target-planning-errors";

export {
  ExistingApplicationChangesRequiredError,
  ExistingAppChangePreimageError,
} from "./target-planning-errors";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const appId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const repositoryPath = z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/@:-]+$/u);
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
      appId,
      appSpec: appSpecBindingSchema,
      version: z.literal(1),
    }),
    futurePath: repositoryPath,
    mutations: z.tuple([]),
    plan: z.strictObject({
      product: z.strictObject({
        appSpec: appSpecBindingSchema,
        optionalCapabilities: z.strictObject({
          hostedResources: z.array(appId),
          integrations: z.array(appId),
        }),
        owner: z.string().min(1),
      }),
      source: z.strictObject({
        packageName: z.string().regex(/^@autograph\/[a-z][a-z0-9-]*$/u),
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
        packageName: z.string().regex(/^@autograph\/[a-z][a-z0-9-]*$/u),
        projectName: z.string().regex(/^apps-[a-z][a-z0-9-]*$/u),
        proposedDigest: digest.optional(),
        routes: z.array(z.string().startsWith("/")),
      }),
    }),
  });

export const targetCreationProposalSchema =
  targetCreationProposalSchemaForTopology("microfrontends.json");

const iterationChangeSchema = z.strictObject({
  after: z.strictObject({
    content: z.string(),
    digest,
    mode: z.string().regex(/^[0-7]{3,4}$/u),
  }),
  before: z
    .strictObject({
      digest,
      mode: z.string().regex(/^[0-7]{3,4}$/u),
    })
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
      if (sha256(JSON.stringify(proposal.iteration.changes)) !== proposal.iteration.digest)
        {context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "The iteration digest does not bind its changes.",
          path: ["iteration", "digest"],
        });}
    });

export const targetIterationProposalSchema =
  targetIterationProposalSchemaForTopology("microfrontends.json");

export const targetProposalSchema = z.union([
  targetCreationProposalSchema,
  targetIterationProposalSchema,
]);

const targetProposalSchemaForTopology = (topologyOwner: string) => {
  if (topologyOwner === "microfrontends.json") {return targetProposalSchema;}
  return z.union([
    targetCreationProposalSchemaForTopology(topologyOwner),
    targetIterationProposalSchemaForTopology(topologyOwner),
  ]);
};

export type TargetIdentity = z.infer<typeof targetIdentitySchema>;
export type TargetProposal = z.infer<typeof targetProposalSchema>;
export type TargetIterationChange = z.infer<typeof iterationChangeSchema>;

export const targetContractDigest = (contract: TargetProposal["contract"]): string =>
  sha256(JSON.stringify(contract));

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

const planningMarker = (marker: string, phase: "start" | "finish") => {
  if (process.env.APP_BUILDER_EXECUTION_BUNDLE === "local-development")
    {console.info(`[app-builder planning] ${marker} ${phase}`);}
};

const parseOutput = <T>(result: TargetCommandResult, schema: z.ZodType<T>, label: string): T => {
  const stdout = result.stdout
    .replaceAll(new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "gu"), "")
    .replaceAll("\r", "")
    .trim();
  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${label} failed with exit code ${result.exitCode}${diagnostic.length === 0 ? "." : `: ${diagnostic.slice(0, 2000)}`}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {throw new Error(`${label} returned an invalid shape.`);}
  return validated.data;
};

export const targetExecutionBinding = (
  cache: ObservedDependencyCache | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  if (hasTestCapability("simulated-target", environment))
    {return {
      dependencyCacheDigest: cache === undefined ? "checkout" : dependencyCacheReceiptDigest(cache),
      fixture: true,
      imageDigest: `fixture@sha256:${"1".repeat(64)}`,
    } as const;}
  const imageDigest = configuredToolchainImage(environment);
  if (cache === undefined)
    {return {
      dependencyCacheDigest: "checkout",
      fixture: false,
      imageDigest: imageDigest ?? "vercel-sandbox",
    } as const;}
  if (imageDigest === undefined) {
    const backend = sandboxBackendPlan({
      environment,
      fixture: false,
      localImageConfigured: false,
    });
    if (backend.kind === "vercel-development" && backend.blockers.length === 0)
      {return {
        dependencyCacheDigest: dependencyCacheReceiptDigest(cache),
        fixture: false,
        imageDigest: developmentExecutionArtifactDigest(environment),
      } as const;}
    if (isHostedVercelSandboxBackend(backend.kind) && backend.blockers.length === 0)
      {return {
        dependencyCacheDigest: dependencyCacheReceiptDigest(cache),
        fixture: false,
        imageDigest: hostedExecutionArtifactDigest(),
      } as const;}
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
  appSpecContent: string;
  appSpecDigest: string;
}) => {
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
};

export const sandboxTargetCommandExecutor =
  (sandbox: SandboxSession): TargetCommandExecutor =>
  async ({ command, appId: requestedAppId, planningRoot, contractPath }) => {
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
        `${result.stdout}\n${result.stderr}`,
      )
    )
      {return result;}

    await sandbox.setNetworkPolicy("allow-all");
    const setup = await sandbox.run({
      abortSignal: AbortSignal.timeout(300_000),
      command: "bun install --ignore-scripts --filter @autograph/platform-microfrontends",
      workingDirectory: planningRoot,
    });
    if (setup.exitCode !== 0) {return setup;}
    return sandbox.run({ ...request, abortSignal });
  };

export const fixtureTargetCommandExecutor =
  (): TargetCommandExecutor =>
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async ({ command, appId: requestedAppId, appSpecDigest }) => {
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
    if (command === "identity")
      {return { exitCode: 0, stderr: "", stdout: JSON.stringify(identity) };}
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

export const executeTargetIdentityAndPlanning = async (input: {
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
}) => {
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
    "Target identity command",
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
  if (JSON.stringify(identity) !== JSON.stringify(expectedIdentity))
    {throw new Error("Target identity did not match the accepted AppSpec.");}
  // Discover the actual prepared checkout. Authored changes may describe a
  // new app, and existing apps do not need a package manifest to be iterable.
  const existingApplicationResult = await input.sandbox.run({
    command: `test -d /workspace/repository/${identity.workspacePath}`,
  });
  const existingApplication = existingApplicationResult.exitCode === 0;
  if (existingApplication && input.existingAppChanges === undefined)
    {throw new ExistingApplicationChangesRequiredError();}
  if (existingApplication && input.existingAppChanges !== undefined) {
    const seen = new Set<string>();
    const changes: TargetIterationChange[] = [];
    for (const requested of input.existingAppChanges) {
      if (
        !safeSourcePath(requested.path) ||
        !requested.path.startsWith(`${identity.workspacePath}/`) ||
        requested.path === identity.contractPath ||
        seen.has(requested.path)
      )
        {throw new Error("An existing-app change path is not allowed.");}
      seen.add(requested.path);
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const before = await input.sandbox.readBinaryFile({
        path: `repository/${requested.path}`,
      });
      const observedMode =
        before === null
          ? undefined
          : // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
            await input.sandbox.run({
              command: `stat -c %a /workspace/repository/${requested.path}`,
            });
      const mode =
        observedMode?.exitCode === 0 && /^[0-7]{3,4}$/u.test(observedMode.stdout.trim())
          ? observedMode.stdout.trim()
          : "644";
      changes.push({
        after: {
          content: requested.content,
          digest: sha256(requested.content),
          mode,
        },
        ...(before === null
          ? {}
          : {
              before: {
                digest: sha256(before),
                mode,
              },
            }),
        path: requested.path,
      });
    }
    if (changes.length === 0) {throw new Error("At least one existing-app change is required.");}
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
    const proposal = targetIterationProposalSchemaForTopology("microfrontends.json").parse({
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
    targetProposalSchemaForTopology("microfrontends.json") as unknown as z.ZodType<TargetProposal>,
    "Target planning command",
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
  )
    {throw new Error("Target proposal did not match the resolved identity.");}
  const result = { identity, proposal, ...overlay };
  planningMarker("target-identity-and-planning", "finish");
  return result;
};
