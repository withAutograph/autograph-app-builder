/* oxlint-disable sonarjs/no-internal-api-use -- Exercise the installed Eve state container with controlled, local-only publication history. */
import { expect, it } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import {
  existingAppRepairHistory,
  priorOwnedAppDraftPublication,
} from "./existing-app-repair-planning";
import { appBuilderWorkflowState } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";

type Reviewed = Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;
type Current = Extract<AppBuilderWorkflowState, { phase: "validated" | "reviewed" }>;
const sessionId = "same-builder-session";
const digest = (character: string) => character.repeat(64);
const within = (operation: () => void) => {
  contextStorage.run(new ContextContainer(), operation);
};

const fixture = (phase: Current["phase"] = "validated") => {
  // SAFETY: This pure lookup consumes only the receipt fields below. No provider,
  // Sandbox, approval or database port is installed, and no omitted receipt field
  // is used as publication authority; the runtime must independently prove that.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Controlled history models only the lookup's immutable lineage fields.
  const prior = {
    version: 17,
    phase: "reviewed",
    publishedGitHubDraftProposalDigest: digest("4"),
    appSpec: { appId: "orchard", digest: digest("a") },
    sourceReceipt: { sourceKind: "fresh-template", digest: digest("b") },
    workspace: {
      workspaceId: "owned-workspace",
      workspacePath: "/workspace/repository",
      workspaceDigest: digest("c"),
      sourceSha: "d".repeat(40),
      sourceTree: "e".repeat(40),
    },
    applyReceipt: { applyRoot: "/workspace/repository/private-overlay" },
    proposal: { digest: digest("f"), target: { operation: "create-app" } },
    reviewReceipt: {
      digest: digest("1"),
      changeSetDigest: digest("2"),
      appSpecDigest: digest("a"),
    },
    githubDestinationReview: {
      digest: digest("3"),
      installation: { installationId: "owned-installation" },
    },
    githubDraftProposal: {
      sourceReceiptDigest: digest("b"),
      destinationReviewDigest: digest("3"),
      proposal: {
        digest: digest("4"),
        reviewDigest: digest("1"),
        changeSetDigest: digest("2"),
        repositoryId: "owned-repository",
      },
    },
  } as unknown as Reviewed;
  const current: Current = {
    ...structuredClone(prior),
    phase,
    proposal: {
      ...prior.proposal,
      digest: digest("5"),
      target: { ...prior.proposal.target, operation: "iterate-existing-app" },
    },
  };
  Reflect.deleteProperty(current, "githubDraftProposal");
  delete current.githubDestinationReview;
  if (current.phase === "reviewed") {
    current.reviewReceipt = { ...prior.reviewReceipt, digest: digest("6") };
  }
  existingAppRepairHistory.update(() => [
    {
      requestDigest: digest("7"),
      proposalDigest: current.proposal.digest,
      sessionId,
      previousWorkflow: prior,
      approvedBase: prior,
    },
  ]);
  appBuilderWorkflowState.update(() => current);
  return { current, prior };
};

it.each(["validated", "reviewed"] as const)(
  "finds the prior owned publication after an ordinary %s revision without a suspended build",
  (phase) => {
    within(() => {
      const f = fixture(phase);
      const history = structuredClone(existingAppRepairHistory.get());
      const workflow = structuredClone(appBuilderWorkflowState.get());
      expect(priorOwnedAppDraftPublication(f.current, sessionId)).toMatchObject({
        installationId: "owned-installation",
        proposal: f.prior.githubDraftProposal?.proposal,
        reviewed: f.prior,
      });
      expect(existingAppRepairHistory.get()).toEqual(history);
      expect(appBuilderWorkflowState.get()).toEqual(workflow);
    });
  },
);

it("selects the published predecessor instead of the current unpublished seal", () => {
  within(() => {
    const f = fixture("reviewed");
    const sealed = f.prior.githubDraftProposal;
    if (sealed === undefined) {
      throw new Error("Missing fixture publication");
    }
    if (f.current.phase !== "reviewed") {
      throw new Error("Missing reviewed fixture");
    }
    f.current.githubDraftProposal = {
      ...sealed,
      proposal: { ...sealed.proposal, digest: digest("8") },
    };
    f.current.publishedGitHubDraftProposalDigest = sealed.proposal.digest;
    expect(priorOwnedAppDraftPublication(f.current, sessionId)?.proposal.digest).toBe(
      sealed.proposal.digest,
    );
  });
});

it("keeps marker-free history as lookup context without claiming publication", () => {
  within(() => {
    const f = fixture();
    delete f.current.publishedGitHubDraftProposalDigest;
    delete f.prior.publishedGitHubDraftProposalDigest;
    const history = structuredClone(existingAppRepairHistory.get());
    expect(priorOwnedAppDraftPublication(f.current, sessionId)?.proposal).toEqual(
      f.prior.githubDraftProposal?.proposal,
    );
    expect(existingAppRepairHistory.get()).toEqual(history);
    expect(appBuilderWorkflowState.get()).toEqual(f.current);
  });
});

it.each([
  "session",
  "app",
  "spec",
  "source",
  "github-source",
  "workspace-id",
  "workspace-path",
  "workspace-digest",
  "source-sha",
  "source-tree",
  "apply-root",
  "publication-marker",
  "source-kind",
  "operation",
] as const)("does not borrow a predecessor with changed %s authority", (binding) => {
  within(() => {
    const f = fixture();
    let owner = sessionId;
    switch (binding) {
      case "session": {
        owner = "another-builder-session";
        break;
      }
      case "app": {
        f.current.appSpec.appId = "another-app";
        break;
      }
      case "spec": {
        f.current.appSpec.digest = digest("9");
        break;
      }
      case "source": {
        f.current.sourceReceipt.digest = digest("9");
        break;
      }
      case "github-source": {
        Reflect.set(f.current, "githubSource", { digest: digest("9") });
        break;
      }
      case "workspace-id": {
        f.current.workspace.workspaceId = "another-workspace";
        break;
      }
      case "workspace-path": {
        Reflect.set(f.current.workspace, "workspacePath", "/workspace/another");
        break;
      }
      case "workspace-digest": {
        f.current.workspace.workspaceDigest = digest("9");
        break;
      }
      case "source-sha": {
        f.current.workspace.sourceSha = "9".repeat(40);
        break;
      }
      case "source-tree": {
        f.current.workspace.sourceTree = "9".repeat(40);
        break;
      }
      case "apply-root": {
        f.current.applyReceipt.applyRoot = "/workspace/another-overlay";
        break;
      }
      case "publication-marker": {
        f.current.publishedGitHubDraftProposalDigest = digest("9");
        break;
      }
      case "source-kind": {
        f.current.sourceReceipt.sourceKind = "existing-repository";
        break;
      }
      case "operation": {
        Reflect.set(f.current.proposal.target, "operation", "create-app");
        break;
      }
      default: {
        throw new Error("Unexpected fixture binding");
      }
    }
    const history = structuredClone(existingAppRepairHistory.get());
    const workflow = structuredClone(appBuilderWorkflowState.get());
    expect(priorOwnedAppDraftPublication(f.current, owner)).toBeUndefined();
    expect(existingAppRepairHistory.get()).toEqual(history);
    expect(appBuilderWorkflowState.get()).toEqual(workflow);
  });
});

it.each([
  "review",
  "change-set",
  "reviewed-spec",
  "source-receipt",
  "destination-digest",
  "destination",
  "seal",
] as const)(
  "requires retained reviewed %s bindings before exposing publication lookup context",
  (binding) => {
    within(() => {
      const f = fixture();
      if (f.prior.githubDraftProposal === undefined) {
        throw new Error("Missing fixture seal");
      }
      if (binding === "review") {
        f.prior.githubDraftProposal.proposal.reviewDigest = digest("9");
      }
      if (binding === "change-set") {
        f.prior.githubDraftProposal.proposal.changeSetDigest = digest("9");
      }
      if (binding === "reviewed-spec") {
        f.prior.reviewReceipt.appSpecDigest = digest("9");
      }
      if (binding === "source-receipt") {
        f.prior.githubDraftProposal.sourceReceiptDigest = digest("9");
      }
      if (binding === "destination-digest") {
        f.prior.githubDraftProposal.destinationReviewDigest = digest("9");
      }
      if (binding === "destination") {
        delete f.prior.githubDestinationReview;
      }
      if (binding === "seal") {
        delete f.prior.githubDraftProposal;
      }
      expect(priorOwnedAppDraftPublication(f.current, sessionId)).toBeUndefined();
    });
  },
);

it("keeps the app available when another app has a more recent history entry", () => {
  within(() => {
    const f = fixture();
    const [entry] = existingAppRepairHistory.get();
    if (entry === undefined) {
      throw new Error("Missing fixture history");
    }
    const other = structuredClone(entry);
    if (!("appSpec" in other.approvedBase)) {
      throw new Error("Missing fixture app");
    }
    other.approvedBase.appSpec.appId = "another-app";
    existingAppRepairHistory.update((history) => [...history, other]);
    expect(priorOwnedAppDraftPublication(f.current, sessionId)?.proposal.digest).toBe(
      f.prior.githubDraftProposal?.proposal.digest,
    );
  });
});
