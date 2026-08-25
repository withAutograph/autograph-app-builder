import type {
  AppBuilderWorkflowState,
  AppCreationProposal,
} from "./workflow-state";
import type { SandboxSession } from "eve/sandbox";

import {
  dependencyCacheReceiptDigest,
  inspectDependencyCache,
} from "../repository/dependency-cache";
import { inspectPreparedSandboxWorkspace } from "../repository/supported-template";
import { targetProposalSchema } from "../repository/target-planning";
import {
  configuredToolchainImage,
  requiredToolVersions,
  toolVersionMatches,
} from "../sandbox/toolchain";
import { sha256 } from "./workflow-state";

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
  expectedProposalDigest: string,
): AppCreationProposal {
  if (
    state.phase !== "planned" &&
    state.phase !== "apply_failed" &&
    state.phase !== "applied" &&
    state.phase !== "validation_pending" &&
    state.phase !== "validation_failed" &&
    state.phase !== "validated" &&
    state.phase !== "reviewed"
  )
    throw new Error(
      "Derive a canonical AppSpec-bound proposal before checking target command readiness.",
    );
  if (state.proposal.digest !== expectedProposalDigest)
    throw new Error(
      "The canonical proposal changed before execution readiness.",
    );
  return state.proposal;
}

export function assertProposalExecutionBindings(
  state: ProposalWorkflowState,
): void {
  const target = targetProposalSchema.safeParse(state.proposal.target);
  if (!target.success)
    throw new Error(
      "The planned proposal no longer matches its durable execution bindings.",
    );
  if (target.data.blockers.length !== 0)
    throw new Error(
      "The planned proposal still contains blockers and cannot be applied.",
    );
  const expected = {
    sourceSha: state.workspace.sourceSha,
    eligibilityDigest: state.workspace.eligibilityDigest,
    workspaceDigest: state.workspace.workspaceDigest,
    imageDigest: state.dependencyReceipt.imageDigest,
    dependencyCacheDigest: state.dependencyReceipt.dependencyCacheDigest,
    appSpecDigest: state.appSpec.digest,
    appSpecPath: state.appSpec.artifactPath,
    artifactRevision: state.appSpec.artifactRevision,
  };
  const actual = {
    sourceSha: state.proposal.sourceSha,
    eligibilityDigest: state.proposal.eligibilityDigest,
    workspaceDigest: state.proposal.workspaceDigest,
    imageDigest: state.proposal.imageDigest,
    dependencyCacheDigest: state.proposal.dependencyCacheDigest,
    appSpecDigest: state.proposal.appSpecDigest,
    appSpecPath: state.proposal.target.contract.appSpec.path,
    artifactRevision: state.proposal.artifactRevision,
  };
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    state.proposal.identityDigest !== state.identityReceipt.digest ||
    target.data.contract.appId !== state.appSpec.appId ||
    target.data.contract.appSpec.path !== state.appSpec.artifactPath ||
    target.data.contract.appSpec.sha256 !== state.appSpec.digest
  )
    throw new Error(
      "The planned proposal no longer matches its durable execution bindings.",
    );
}

export function targetExecutionBlockers(input: {
  imageConfigured: boolean;
  toolchainReady: boolean;
}): string[] {
  const blockers: string[] = [];
  if (!input.imageConfigured)
    blockers.push("No immutable sandbox image is configured.");
  if (!input.toolchainReady)
    blockers.push(
      "The sandbox does not prove the exact required Git, mise, and Bun toolchain.",
    );
  return blockers;
}

const commands = ["bash", "git", "mise", "bun", "node", "pnpm"] as const;

export async function inspectTargetExecutionReadiness(input: {
  state: ProposalWorkflowState;
  sandbox: SandboxSession;
  expectedProposalDigest: string;
  environment?: Readonly<Record<string, string | undefined>>;
}) {
  const environment = input.environment ?? process.env;
  const proposal = plannedProposalForExecution(
    input.state,
    input.expectedProposalDigest,
  );
  assertProposalExecutionBindings(input.state);
  const observed = await inspectPreparedSandboxWorkspace(input.sandbox);
  if (
    observed.state !== "prepared" ||
    JSON.stringify(observed.workspace) !== JSON.stringify(input.state.workspace)
  )
    throw new Error(
      "The prepared workspace receipt changed before execution readiness.",
    );
  const fixture =
    environment.APP_BUILDER_TEST_MODEL === "1" &&
    environment.APP_BUILDER_REAL_SANDBOX !== "1";
  const tools = fixture
    ? commands.map((command) => ({
        command,
        available: true as const,
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
          if (location.exitCode !== 0)
            return { command, available: false as const, version: "" };
          const version = await input.sandbox.run({
            command: `${command} --version`,
          });
          return {
            command,
            available: true as const,
            version:
              (version.stdout.trim() || version.stderr.trim()).split("\n")[0] ??
              "",
          };
        }),
      );
  const image = fixture
    ? input.state.dependencyReceipt.imageDigest
    : configuredToolchainImage(environment);
  const cache =
    image === undefined
      ? undefined
      : await inspectDependencyCache(input.sandbox, environment).catch(
          () => undefined,
        );
  const required = (
    Object.keys(requiredToolVersions) as Array<
      keyof typeof requiredToolVersions
    >
  ).map((command) => {
    const observedTool = tools.find((tool) => tool.command === command);
    return {
      command,
      expected: requiredToolVersions[command].source,
      version: observedTool?.version ?? "",
      matches:
        observedTool?.available === true &&
        (fixture || toolVersionMatches(command, observedTool.version)),
    };
  });
  const toolchainReady =
    image !== undefined &&
    cache !== undefined &&
    input.state.dependencyReceipt.imageDigest === image &&
    input.state.dependencyReceipt.dependencyCacheDigest ===
      dependencyCacheReceiptDigest(cache) &&
    input.state.dependencyReceipt.cacheManifestDigest ===
      cache.manifestDigest &&
    input.state.dependencyReceipt.cacheContentDigest === cache.contentDigest &&
    required.every((tool) => tool.matches);
  const blockers = targetExecutionBlockers({
    imageConfigured: image !== undefined,
    toolchainReady,
  });
  const readiness = {
    sourceSha: input.state.workspace.sourceSha,
    eligibilityDigest: input.state.workspace.eligibilityDigest,
    workspaceDigest: input.state.workspace.workspaceDigest,
    appSpecDigest: input.state.appSpec.digest,
    appSpecPath: input.state.appSpec.artifactPath,
    artifactRevision: input.state.appSpec.artifactRevision,
    dependencyReceiptDigest: input.state.dependencyReceipt.digest,
    identityDigest: input.state.identityReceipt.digest,
    proposalDigest: proposal.digest,
    imageDigest: image ?? "unconfigured",
    dependencyCacheDigest:
      cache === undefined ? "unverified" : dependencyCacheReceiptDigest(cache),
    required,
  };
  return {
    ...readiness,
    applyReadinessDigest: sha256(JSON.stringify(readiness)),
    targetCommandReady: blockers.length === 0,
    blockers,
  };
}
