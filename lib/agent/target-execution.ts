import type { SandboxSession } from "eve/sandbox";

import { inspectSourceBoundSandboxWorkspace } from "../repository/arrusted-template";
import {
  dependencyCacheReceiptDigest,
  dependencyTargetForWorkspace,
  inspectDependencyCache,
  shouldPreferLiveTemplateDependencies,
} from "../repository/dependency-cache";
import type { ObservedDependencyCache } from "../repository/dependency-cache";
import {
  targetExecutionBinding,
  targetProposalSchema,
} from "../repository/target-planning";
import {
  isHostedVercelSandboxBackend,
  sandboxBackendPlan,
} from "../sandbox/backend";
import {
  configuredToolchainImage,
  requiredToolVersions,
} from "../sandbox/toolchain";
import { hasTestCapability } from "../testing/test-capability";
import type {
  AppBuilderWorkflowState,
  AppCreationProposal,
} from "./workflow-state";
import {
  assertExactDependencyPreparationReceipt,
  sha256,
} from "./workflow-state";

export type ProposalWorkflowState = Extract<
  AppBuilderWorkflowState,
  {
    phase:
      | "planned"
      | "apply_failed"
      | "applied"
      | "validation_pending"
      | "validation_failed"
      | "validated"
      | "reviewed";
  }
>;

export function plannedProposalForExecution(
  state: AppBuilderWorkflowState,
  expectedProposalDigest: string
): AppCreationProposal {
  if (
    state.phase !== "planned" &&
    state.phase !== "apply_failed" &&
    state.phase !== "applied" &&
    state.phase !== "validation_pending" &&
    state.phase !== "validation_failed" &&
    state.phase !== "validated" &&
    state.phase !== "reviewed"
  ) {
    throw new Error(
      "Derive a canonical AppSpec-bound proposal before checking target command readiness."
    );
  }
  if (state.proposal.digest !== expectedProposalDigest) {
    throw new Error(
      "The canonical proposal changed before execution readiness."
    );
  }
  return state.proposal;
}

export function assertProposalExecutionBindings(
  state: ProposalWorkflowState
): void {
  assertExactDependencyPreparationReceipt(state.dependencyReceipt);
  const target = targetProposalSchema.safeParse(state.proposal.target);
  if (!target.success) {
    throw new Error(
      "The planned proposal no longer matches its durable execution bindings."
    );
  }
  if (target.data.blockers.length !== 0) {
    throw new Error(
      "The planned proposal still contains blockers and cannot be applied."
    );
  }
  const expected = {
    appSpecDigest: state.appSpec.digest,
    appSpecPath: state.appSpec.artifactPath,
    artifactRevision: state.appSpec.artifactRevision,
    dependencyCacheDigest: state.dependencyReceipt.dependencyCacheDigest,
    eligibilityDigest: state.workspace.eligibilityDigest,
    imageDigest: state.dependencyReceipt.imageDigest,
    sourceReceiptDigest: state.sourceReceipt.digest,
    sourceSha: state.workspace.sourceSha,
    sourceTree: state.workspace.sourceTree,
    workspaceDigest: state.workspace.workspaceDigest,
  };
  const actual = {
    appSpecDigest: state.proposal.appSpecDigest,
    appSpecPath: state.proposal.target.contract.appSpec.path,
    artifactRevision: state.proposal.artifactRevision,
    dependencyCacheDigest: state.proposal.dependencyCacheDigest,
    eligibilityDigest: state.proposal.eligibilityDigest,
    imageDigest: state.proposal.imageDigest,
    sourceReceiptDigest: state.proposal.sourceReceiptDigest,
    sourceSha: state.proposal.sourceSha,
    sourceTree: state.proposal.sourceTree,
    workspaceDigest: state.proposal.workspaceDigest,
  };
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    state.proposal.identityDigest !== state.identityReceipt.digest ||
    target.data.contract.appId !== state.appSpec.appId ||
    target.data.contract.appSpec.path !== state.appSpec.artifactPath ||
    target.data.contract.appSpec.sha256 !== state.appSpec.digest
  ) {
    throw new Error(
      "The planned proposal no longer matches its durable execution bindings."
    );
  }
}

export function targetExecutionBlockers(input: {
  imageConfigured: boolean;
  toolchainReady: boolean;
  capabilityBlockers?: readonly string[];
}): string[] {
  const blockers: string[] = [...(input.capabilityBlockers ?? [])];
  if (!input.imageConfigured) {
    blockers.push("No immutable sandbox image is configured.");
  }
  if (!input.toolchainReady) {
    blockers.push(
      "The sandbox execution environment or a required command is unavailable."
    );
  }
  return blockers;
}

const commands = ["bash", "git", "mise", "bun", "node", "pnpm"] as const;

export function resolveTargetExecutionEnvironment(input: {
  environment: Readonly<Record<string, string | undefined>>;
  fixture: boolean;
  cache?: ObservedDependencyCache;
}) {
  const localImage = configuredToolchainImage(input.environment);
  const backend = sandboxBackendPlan({
    environment: input.environment,
    fixture: input.fixture,
    localImageConfigured: localImage !== undefined,
  });
  const cacheInspectable =
    backend.blockers.length === 0 &&
    (input.fixture ||
      localImage !== undefined ||
      isHostedVercelSandboxBackend(backend.kind));
  const execution =
    cacheInspectable && input.cache !== undefined
      ? targetExecutionBinding(input.cache, input.environment)
      : undefined;
  return {
    backend,
    cacheInspectable,
    imageDigest: execution?.imageDigest,
  };
}

export async function inspectTargetExecutionReadiness(input: {
  state: ProposalWorkflowState;
  sandbox: SandboxSession;
  expectedProposalDigest: string;
  environment?: Readonly<Record<string, string | undefined>>;
}) {
  const environment = input.environment ?? process.env;
  const proposal = plannedProposalForExecution(
    input.state,
    input.expectedProposalDigest
  );
  assertProposalExecutionBindings(input.state);
  await inspectSourceBoundSandboxWorkspace({
    expectedWorkspace: input.state.workspace,
    receipt: input.state.sourceReceipt,
    sandbox: input.sandbox,
    ...(input.state.githubSource === undefined
      ? {}
      : { githubSource: input.state.githubSource }),
  });
  const fixture = hasTestCapability("simulated-target", environment);
  const tools = fixture
    ? commands.map((command) => ({
        available: true as const,
        command,
        version:
          command in requiredToolVersions
            ? `fixture ${requiredToolVersions[command as keyof typeof requiredToolVersions].source}`
            : "fixture available",
      }))
    : await Promise.all(
        commands.map(async (command) => {
          const location = await input.sandbox.run({
            command: `command -v ${command}`,
          });
          if (location.exitCode !== 0) {
            return { command, available: false as const, version: "" };
          }
          const version = await input.sandbox.run({
            command: `${command} --version`,
          });
          return {
            available: true as const,
            command,
            version:
              (version.stdout.trim() || version.stderr.trim()).split("\n")[0] ??
              "",
          };
        })
      );
  const executionEnvironment = resolveTargetExecutionEnvironment({
    environment,
    fixture,
  });
  const cache = executionEnvironment.cacheInspectable
    ? await inspectDependencyCache(
        input.sandbox,
        environment,
        input.state.workspace,
        shouldPreferLiveTemplateDependencies(
          input.state.sourceReceipt.version,
          environment
        )
      ).catch(() => {})
    : undefined;
  const resolvedExecutionEnvironment = resolveTargetExecutionEnvironment({
    cache,
    environment,
    fixture,
  });
  const image = resolvedExecutionEnvironment.imageDigest;
  const { backend } = resolvedExecutionEnvironment;
  const required = (
    Object.keys(requiredToolVersions) as (keyof typeof requiredToolVersions)[]
  ).map((command) => {
    const observedTool = tools.find((tool) => tool.command === command);
    return {
      available: observedTool?.available === true,
      command,
      expected: requiredToolVersions[command].source,
      version: observedTool?.version ?? "",
    };
  });
  const toolchainReady =
    backend.blockers.length === 0 &&
    image !== undefined &&
    required.every((tool) => tool.available);
  const blockers = targetExecutionBlockers({
    capabilityBlockers: backend.blockers,
    imageConfigured: image !== undefined,
    toolchainReady,
  });
  const dependencyTarget =
    cache === undefined
      ? undefined
      : dependencyTargetForWorkspace(cache, input.state.workspace);
  const readiness = {
    appSpecDigest: input.state.appSpec.digest,
    appSpecPath: input.state.appSpec.artifactPath,
    artifactRevision: input.state.appSpec.artifactRevision,
    dependencyCacheDigest:
      cache === undefined ? "unverified" : dependencyCacheReceiptDigest(cache),
    dependencyReceiptDigest: input.state.dependencyReceipt.digest,
    eligibilityDigest: input.state.workspace.eligibilityDigest,
    identityDigest: input.state.identityReceipt.digest,
    imageDigest: image ?? "unconfigured",
    proposalDigest: proposal.digest,
    required,
    sourceReceiptDigest: input.state.sourceReceipt.digest,
    sourceSha: input.state.workspace.sourceSha,
    sourceTree: input.state.workspace.sourceTree,
    targetSha: dependencyTarget?.sha ?? "unverified",
    targetTree: dependencyTarget?.tree ?? "unverified",
    workspaceDigest: input.state.workspace.workspaceDigest,
  };
  return {
    ...readiness,
    applyReadinessDigest: sha256(JSON.stringify(readiness)),
    blockers,
    targetCommandReady: blockers.length === 0,
  };
}
