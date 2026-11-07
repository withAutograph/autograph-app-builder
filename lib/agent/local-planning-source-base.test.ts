import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { localPlanningSourceBase } from "./local-planning-source-base";

const fixture = () => {
  const appSpec = { appId: "example", artifactRevision: "b".repeat(64), digest: "a".repeat(64) };
  const sourceReceipt = { digest: "d".repeat(64), sourceSha: "c".repeat(40) };
  const original = {
    appSpecDigest: appSpec.digest,
    artifactRevision: appSpec.artifactRevision,
    sourceReceiptDigest: sourceReceipt.digest,
    sourceSha: sourceReceipt.sourceSha,
    target: { contract: { appId: appSpec.appId } },
    workspaceDigest: "e".repeat(64),
  };
  const proposal = {
    ...original,
    digest: createHash("sha256").update(JSON.stringify(original)).digest("hex"),
  };
  const workspace = {
    sourceSha: "f".repeat(40),
    workspaceDigest: "1".repeat(64),
    workspaceId: "same-owned-workspace",
    workspacePath: "/workspace/repository" as const,
  };
  const applyReceipt = {
    appSpecDigest: appSpec.digest,
    applyRoot: workspace.workspacePath,
    proposalDigest: proposal.digest,
    sourceReceiptDigest: sourceReceipt.digest,
    sourceSha: original.sourceSha,
    workspaceDigest: original.workspaceDigest,
  };
  return { appSpec, applyReceipt, proposal, sourceReceipt, workspace };
};
test("saved proposal/apply provenance identifies old bytes after live workspace metadata was overlaid", () => {
  const state = fixture();
  expect(localPlanningSourceBase(state)).toEqual({
    sourceOverlay: {
      sourceSha: state.workspace.sourceSha,
      workspaceDigest: state.workspace.workspaceDigest,
    },
    sourceSha: state.proposal.sourceSha,
    workspaceDigest: state.proposal.workspaceDigest,
    workspaceId: state.workspace.workspaceId,
  });
});
test("changed product, proposal, source or apply provenance cannot invent an original baseline", () => {
  const state = fixture();
  expect(() =>
    localPlanningSourceBase({ ...state, proposal: { ...state.proposal, digest: "f".repeat(64) } }),
  ).toThrow();
  expect(() =>
    localPlanningSourceBase({ ...state, appSpec: { ...state.appSpec, digest: "f".repeat(64) } }),
  ).toThrow();
  expect(() =>
    localPlanningSourceBase({
      ...state,
      sourceReceipt: { ...state.sourceReceipt, sourceSha: "f".repeat(40) },
    }),
  ).toThrow();
  expect(() =>
    localPlanningSourceBase({
      ...state,
      applyReceipt: { ...state.applyReceipt, workspaceDigest: state.workspace.workspaceDigest },
    }),
  ).toThrow();
});
