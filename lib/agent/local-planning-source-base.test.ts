import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { localPlanningSourceBase } from "./local-planning-source-base";

const fixture = () => {
  const appSpec = { appId: "example", digest: "a".repeat(64), artifactRevision: "b".repeat(64) };
  const sourceReceipt = { sourceSha: "c".repeat(40), digest: "d".repeat(64) };
  const original = {
    sourceSha: sourceReceipt.sourceSha,
    sourceReceiptDigest: sourceReceipt.digest,
    workspaceDigest: "e".repeat(64),
    appSpecDigest: appSpec.digest,
    artifactRevision: appSpec.artifactRevision,
    target: { contract: { appId: appSpec.appId } },
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
    proposalDigest: proposal.digest,
    sourceSha: original.sourceSha,
    workspaceDigest: original.workspaceDigest,
    sourceReceiptDigest: sourceReceipt.digest,
    appSpecDigest: appSpec.digest,
    applyRoot: workspace.workspacePath,
  };
  return { appSpec, applyReceipt, proposal, sourceReceipt, workspace };
};
test("saved proposal/apply provenance identifies old bytes after live workspace metadata was overlaid", () => {
  const state = fixture();
  expect(localPlanningSourceBase(state)).toEqual({
    sourceSha: state.proposal.sourceSha,
    workspaceDigest: state.proposal.workspaceDigest,
    workspaceId: state.workspace.workspaceId,
    sourceOverlay: {
      sourceSha: state.workspace.sourceSha,
      workspaceDigest: state.workspace.workspaceDigest,
    },
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
