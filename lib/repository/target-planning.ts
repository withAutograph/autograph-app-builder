import { createHash } from "node:crypto";

import { z } from "zod";

import type { SandboxSession } from "eve/sandbox";
import { hasTestCapability } from "../testing/test-capability";

import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { safeSourcePath } from "./source-path";

import {
  dependencyCacheReceiptDigest,
  planningOverlayRoot,
  type ObservedDependencyCache,
} from "./dependency-cache";
import { configuredToolchainImage } from "../sandbox/toolchain";
import {
  isHostedVercelSandboxBackend,
  sandboxBackendPlan,
} from "../sandbox/backend";
import { hostedExecutionArtifactDigest } from "../sandbox/hosted-artifact";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const appId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const repositoryPath = z
  .string()
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/@:-]+$/u);

export const targetIdentitySchema = z.strictObject({
  appId,
  workspacePath: repositoryPath,
  packageName: z.string().regex(/^@autograph\/[a-z][a-z0-9-]*$/u),
  projectName: z.string().regex(/^apps-[a-z][a-z0-9-]*$/u),
  baseRoutes: z.tuple([z.string().startsWith("/"), z.string().startsWith("/")]),
  appSpecPath: repositoryPath,
  contractPath: repositoryPath,
  kernelSchemaPath: repositoryPath,
});

const appSpecBindingSchema = z.strictObject({
  path: repositoryPath,
  sha256: digest,
});

const targetCreationProposalSchema = z.strictObject({
  contract: z.strictObject({
    version: z.literal(1),
    appId,
    appSpec: appSpecBindingSchema,
  }),
  futurePath: repositoryPath,
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
      configPath: z.literal("microfrontends.json"),
      projectName: z.string().regex(/^apps-[a-z][a-z0-9-]*$/u),
      packageName: z.string().regex(/^@autograph\/[a-z][a-z0-9-]*$/u),
      routes: z.array(z.string().startsWith("/")),
      assetRoute: z.string().startsWith("/").optional(),
      currentDigest: digest.optional(),
      proposedDigest: digest.optional(),
    }),
  }),
  blockers: z.array(z.string()),
  mutations: z.tuple([]),
});

const iterationChangeSchema = z.strictObject({
  path: repositoryPath,
  before: z.strictObject({ mode: z.string().regex(/^[0-7]{3,4}$/u), digest }),
  after: z.strictObject({
    mode: z.string().regex(/^[0-7]{3,4}$/u),
    digest,
    content: z.string().max(262_144),
  }),
});

export const targetIterationProposalSchema =
  targetCreationProposalSchema.extend({
    operation: z.literal("iterate-existing-app"),
    iteration: z.strictObject({
      changes: z.array(iterationChangeSchema).min(1).max(32),
      digest,
    }),
  });

export const targetProposalSchema = z.union([
  targetCreationProposalSchema,
  targetIterationProposalSchema,
]);

export type TargetIdentity = z.infer<typeof targetIdentitySchema>;
export type TargetProposal = z.infer<typeof targetProposalSchema>;
export type TargetIterationChange = z.infer<typeof iterationChangeSchema>;

export function targetContractDigest(
  contract: TargetProposal["contract"],
): string {
  return sha256(JSON.stringify(contract));
}

export const TARGET_COMMAND_TIMEOUT_MS = 30_000;
export const TARGET_COMMAND_OUTPUT_BYTES = 1_048_576;
export const TARGET_PLANNING_MISE_PROFILE = `[settings]
exec_auto_install = false
not_found_auto_install = false
task.run_auto_install = false

[deps]
disable = ["bun"]
`;

export type TargetCommand = "identity" | "planning";
export type TargetCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
export type TargetCommandExecutor = (input: {
  command: TargetCommand;
  appId: string;
  planningRoot: string;
  contractPath: string;
  appSpecDigest: string;
}) => Promise<TargetCommandResult>;

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function parseOutput<T>(
  result: TargetCommandResult,
  schema: z.ZodType<T>,
  label: string,
): T {
  if (
    Buffer.byteLength(result.stdout) > TARGET_COMMAND_OUTPUT_BYTES ||
    Buffer.byteLength(result.stderr) > TARGET_COMMAND_OUTPUT_BYTES
  )
    throw new Error(`${label} output exceeded the fixed size limit.`);
  if (result.exitCode !== 0)
    throw new Error(`${label} failed with exit code ${result.exitCode}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success)
    throw new Error(`${label} returned an invalid shape.`);
  return validated.data;
}

export function targetExecutionBinding(
  cache: ObservedDependencyCache,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (hasTestCapability("simulated-target", environment))
    return {
      imageDigest: `fixture@sha256:${"1".repeat(64)}`,
      dependencyCacheDigest: dependencyCacheReceiptDigest(cache),
      fixture: true,
    } as const;
  const imageDigest = configuredToolchainImage(environment);
  if (imageDigest === undefined) {
    const backend = sandboxBackendPlan({
      environment,
      fixture: false,
      localImageConfigured: false,
    });
    if (
      isHostedVercelSandboxBackend(backend.kind) &&
      backend.blockers.length === 0
    )
      return {
        imageDigest: hostedExecutionArtifactDigest(),
        dependencyCacheDigest: dependencyCacheReceiptDigest(cache),
        fixture: false,
      } as const;
    throw new Error(
      "The immutable sandbox image and offline dependency cache are not ready for target commands.",
    );
  }
  return {
    imageDigest,
    dependencyCacheDigest: dependencyCacheReceiptDigest(cache),
    fixture: false,
  } as const;
}

type SourceFile = { path: string };

const fixturePlanningEnabled = () => hasTestCapability("simulated-target");

export async function materializePlanningOverlay(input: {
  sandbox: SandboxSession;
  artifactRevision: string;
  appId: string;
  appSpecContent: string;
  appSpecDigest: string;
}) {
  const manifest = await input.sandbox.readTextFile({
    path: ".app-builder/source-files.json",
  });
  if (manifest === null)
    throw new Error("Prepared source manifest is missing.");
  const parsed = JSON.parse(manifest) as unknown;
  if (!Array.isArray(parsed))
    throw new Error("Prepared source manifest is invalid.");
  const files = parsed as SourceFile[];
  const root = planningOverlayRoot(input.artifactRevision);
  for (const file of files) {
    if (typeof file.path !== "string" || !safeSourcePath(file.path))
      throw new Error("Prepared source manifest is invalid.");
  }
  await ensureSandboxDirectories(input.sandbox, [
    root,
    `${root}/prototype/${input.appId}`,
    `.app-builder/target-inputs/${input.artifactRevision}`,
  ]);
  if (fixturePlanningEnabled()) {
    for (const file of files) {
      const content = await input.sandbox.readBinaryFile({
        path: `repository/${file.path}`,
      });
      if (content === null) throw new Error("Prepared source file is missing.");
      await input.sandbox.writeBinaryFile({
        path: `${root}/${file.path}`,
        content,
      });
    }
  } else {
    const copy = await input.sandbox.run({
      command: `tar --create --file - --exclude=node_modules -C repository . | tar --extract --file - --directory ${root}`,
      workingDirectory: "/workspace",
      abortSignal: AbortSignal.timeout(TARGET_COMMAND_TIMEOUT_MS),
    });
    if (copy.exitCode !== 0)
      throw new Error("The prepared source could not be copied for planning.");
  }
  const appSpecPath = `prototype/${input.appId}/app-spec.md`;
  await input.sandbox.writeTextFile({
    path: `${root}/${appSpecPath}`,
    content: input.appSpecContent,
  });
  const contract = {
    version: 1,
    appId: input.appId,
    appSpec: { path: appSpecPath, sha256: input.appSpecDigest },
  } as const;
  const contractPath = `.app-builder/target-inputs/${input.artifactRevision}/app-contract.json`;
  await input.sandbox.writeTextFile({
    path: contractPath,
    content: `${JSON.stringify(contract, null, 2)}\n`,
  });
  await input.sandbox.writeTextFile({
    path: `${root}/.config/mise/config.app-builder.toml`,
    content: TARGET_PLANNING_MISE_PROFILE,
  });
  return {
    planningRoot: `/workspace/${root}`,
    contractPath: `/workspace/${contractPath}`,
    contractDigest: targetContractDigest(contract),
  };
}

export function sandboxTargetCommandExecutor(
  sandbox: SandboxSession,
): TargetCommandExecutor {
  return async ({
    command,
    appId: requestedAppId,
    planningRoot,
    contractPath,
  }) => {
    const abortSignal = AbortSignal.timeout(TARGET_COMMAND_TIMEOUT_MS);
    const mise =
      "MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false mise --env app-builder run --no-deps --skip-tools repository:exec --";
    const request =
      command === "identity"
        ? {
            command: `${mise} app-identity.ts --app ${requestedAppId}`,
            workingDirectory: planningRoot,
          }
        : {
            command: `${mise} app-contract.ts --contract ${contractPath} --root ${planningRoot}`,
            workingDirectory: planningRoot,
          };
    return sandbox.run({ ...request, abortSignal });
  };
}

export function fixtureTargetCommandExecutor(): TargetCommandExecutor {
  return async ({ command, appId: requestedAppId, appSpecDigest }) => {
    const identity = {
      appId: requestedAppId,
      workspacePath: `apps/${requestedAppId}`,
      packageName: `@autograph/${requestedAppId}`,
      projectName: `apps-${requestedAppId}`,
      baseRoutes: [`/${requestedAppId}`, `/${requestedAppId}/:path*`],
      appSpecPath: `prototype/${requestedAppId}/app-spec.md`,
      contractPath: `apps/${requestedAppId}/app.contract.json`,
      kernelSchemaPath: `apps/${requestedAppId}/schema/${requestedAppId}-schema.json`,
    };
    if (command === "identity")
      return { exitCode: 0, stdout: JSON.stringify(identity), stderr: "" };
    const proposal = {
      contract: {
        version: 1,
        appId: requestedAppId,
        appSpec: { path: identity.appSpecPath, sha256: appSpecDigest },
      },
      futurePath: identity.contractPath,
      plan: {
        source: {
          workspacePath: identity.workspacePath,
          runtime: "nextjs",
          packageName: identity.packageName,
          schema: { kind: "none" },
        },
        product: {
          owner: "fixture-owner",
          appSpec: { path: identity.appSpecPath, sha256: appSpecDigest },
          optionalCapabilities: { integrations: [], hostedResources: [] },
        },
        topology: {
          configPath: "microfrontends.json",
          projectName: identity.projectName,
          packageName: identity.packageName,
          routes: identity.baseRoutes,
        },
      },
      blockers: [],
      mutations: [],
    };
    return { exitCode: 0, stdout: JSON.stringify(proposal), stderr: "" };
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
  onIdentity?: (identity: TargetIdentity) => void | Promise<void>;
}) {
  const overlay = await materializePlanningOverlay(input);
  const identity = parseOutput(
    await input.executor({
      command: "identity",
      appId: input.appId,
      appSpecDigest: input.appSpecDigest,
      ...overlay,
    }),
    targetIdentitySchema,
    "Target identity command",
  );
  const expectedIdentity = {
    appId: input.appId,
    workspacePath: `apps/${input.appId}`,
    packageName: `@autograph/${input.appId}`,
    projectName: `apps-${input.appId}`,
    baseRoutes: [`/${input.appId}`, `/${input.appId}/:path*`],
    appSpecPath: `prototype/${input.appId}/app-spec.md`,
    contractPath: `apps/${input.appId}/app.contract.json`,
    kernelSchemaPath: `apps/${input.appId}/schema/${input.appId}-schema.json`,
  };
  if (JSON.stringify(identity) !== JSON.stringify(expectedIdentity))
    throw new Error("Target identity did not match the accepted AppSpec.");
  await input.onIdentity?.(identity);
  const manifestSource = await input.sandbox.readTextFile({
    path: ".app-builder/source-files.json",
  });
  if (manifestSource === null)
    throw new Error("Prepared source manifest is missing.");
  const manifest = JSON.parse(manifestSource) as unknown;
  if (!Array.isArray(manifest))
    throw new Error("Prepared source manifest is invalid.");
  const files = new Map(
    manifest.flatMap((candidate): [string, { mode: string }][] => {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("path" in candidate) ||
        typeof candidate.path !== "string" ||
        !("mode" in candidate) ||
        typeof candidate.mode !== "string"
      )
        return [];
      return [[candidate.path, { mode: candidate.mode.replace(/^100/u, "") }]];
    }),
  );
  const existingApplication = [...files.keys()].some((path) =>
    path.startsWith(`${identity.workspacePath}/`),
  );
  if (existingApplication && input.existingAppChanges === undefined)
    throw new Error(
      "The requested application already exists. Inspect its app-owned source files, then retry target planning with exact replacement contents.",
    );
  if (input.existingAppChanges !== undefined) {
    if (!existingApplication)
      throw new Error("The requested existing application does not exist.");
    const seen = new Set<string>();
    const changes: TargetIterationChange[] = [];
    for (const requested of input.existingAppChanges) {
      if (
        !safeSourcePath(requested.path) ||
        !requested.path.startsWith(`${identity.workspacePath}/`) ||
        requested.path === identity.contractPath ||
        seen.has(requested.path)
      )
        throw new Error("An existing-app change path is not allowed.");
      seen.add(requested.path);
      const entry = files.get(requested.path);
      if (entry === undefined)
        throw new Error(
          "An existing-app change is not bound to a source preimage.",
        );
      const before = await input.sandbox.readBinaryFile({
        path: `repository/${requested.path}`,
      });
      if (before === null)
        throw new Error("An existing-app source preimage is missing.");
      changes.push({
        path: requested.path,
        before: { mode: entry.mode, digest: sha256(before) },
        after: {
          mode: entry.mode,
          digest: sha256(requested.content),
          content: requested.content,
        },
      });
    }
    if (changes.length === 0)
      throw new Error("At least one existing-app change is required.");
    const topologyBytes = await input.sandbox.readBinaryFile({
      path: `repository/microfrontends.json`,
    });
    if (topologyBytes === null)
      throw new Error("The existing application topology is missing.");
    const topologyDigest = sha256(topologyBytes);
    const contract = {
      version: 1 as const,
      appId: input.appId,
      appSpec: {
        path: identity.appSpecPath,
        sha256: input.appSpecDigest,
      },
    };
    const iterationDigest = sha256(JSON.stringify(changes));
    const proposal = targetIterationProposalSchema.parse({
      operation: "iterate-existing-app",
      contract,
      futurePath: identity.contractPath,
      plan: {
        source: {
          workspacePath: identity.workspacePath,
          runtime: "nextjs",
          packageName: identity.packageName,
          schema: { kind: "none" },
        },
        product: {
          owner: "existing-application-owner",
          appSpec: contract.appSpec,
          optionalCapabilities: { integrations: [], hostedResources: [] },
        },
        topology: {
          configPath: "microfrontends.json",
          projectName: identity.projectName,
          packageName: identity.packageName,
          routes: identity.baseRoutes,
          currentDigest: topologyDigest,
          proposedDigest: topologyDigest,
        },
      },
      blockers: [],
      mutations: [],
      iteration: { changes, digest: iterationDigest },
    });
    return { identity, proposal, ...overlay };
  }
  const proposal = parseOutput(
    await input.executor({
      command: "planning",
      appId: input.appId,
      appSpecDigest: input.appSpecDigest,
      ...overlay,
    }),
    targetProposalSchema,
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
    throw new Error("Target proposal did not match the resolved identity.");
  return { identity, proposal, ...overlay };
}
