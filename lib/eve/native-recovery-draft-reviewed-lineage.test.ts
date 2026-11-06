/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, eslint/require-await -- Installed SDK private runtime APIs remain opaque; synthetic hooks preserve their asynchronous contract. */
/* oxlint-disable anti-slop/no-unknown-parameters -- Installed SDK fixtures accept opaque native storage values. */
import { expect, it } from "vitest";
import { z } from "zod";
import { currentDraftCandidateSource } from "../agent/published-draft-repair";
import {
  recoverDraftReviewedLineage,
  draftReviewedLineageContextKey,
} from "./native-recovery-draft-reviewed-lineage";
import {
  fixture,
  freshFixture,
  nativeFixture,
  recoverTerminalSession,
  workflowKey,
} from "./test-support/draft-reviewed-recovery";

it("restores a complete fresh-template review against the verified owned publication without replacing latest edits", async () => {
  const f = await freshFixture();
  const before = structuredClone(f.input);
  const review = recoverDraftReviewedLineage(f.input);
  expect(review).toEqual(f.reviewed);
  expect(f.input).toEqual(before);
  const selected = { ...f.candidate, reviewedLineage: review };
  const source = currentDraftCandidateSource(f.currentContext[workflowKey], selected);
  expect(source?.repository.repositoryId).toBe("100");
  expect(selected.root).toBe("/workspace/same-draft");
  expect(selected.unpublished).toBe("actual unchanged edits");
});

it("accepts same-slot reviews with equivalent persisted JSON despite key order or omitted undefined", async () => {
  const f = await freshFixture();
  const duplicate = structuredClone(f.old);
  const reordered = Object.fromEntries(Object.entries(f.reviewed).toReversed());
  reordered.optionalTransient = undefined;
  Reflect.set(duplicate.serializedContext, workflowKey, reordered);
  f.input.payload.candidates.push(duplicate);
  expect(recoverDraftReviewedLineage(f.input)).toEqual(f.reviewed);
});

it("keeps a legitimate newer merge base for the same owned reconciliation candidate", async () => {
  const f = await freshFixture();
  f.candidate.baseSha = "c".repeat(40);
  f.candidate.baseTree = "d".repeat(40);
  expect(recoverDraftReviewedLineage(f.input)).toEqual(f.reviewed);
  const candidate = { ...f.candidate, reviewedLineage: f.reviewed };
  expect(currentDraftCandidateSource(f.currentContext[workflowKey], candidate)).toEqual(
    f.candidate.publishedOrigin.source,
  );
});

it("refuses an ambiguous reviewed checkpoint at the selected validated slot", async () => {
  const f = await freshFixture();
  f.input.payload.candidates.push({
    ...structuredClone(f.old),
    origin: { ...f.current.origin, eventId: "ambiguous-event", stepId: "ambiguous-step" },
  });
  expect(recoverDraftReviewedLineage(f.input)).toBeUndefined();
});

it.each([
  "missing-review",
  "foreign-owner",
  "foreign-session",
  "existing-repository-review",
  "wrong-app",
  "wrong-review",
  "wrong-repository",
  "wrong-pr",
  "wrong-head",
  "wrong-source",
  "wrong-publication",
  "tampered-repair",
  "tampered-publication-receipt",
  "missing-publication-scope",
  "malformed-review",
  "conflicting-review",
  // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Each case mutates one distinct authority binding.
] as const)("refuses fresh-template recovery with %s", async (variant) => {
  const f = await freshFixture();
  if (variant === "missing-review") {
    f.input.payload.candidates.shift();
  }
  if (variant === "foreign-owner") {
    f.input.binding.ownerRunId = "foreign";
  }
  if (variant === "foreign-session") {
    f.input.binding.logicalSessionId = "foreign";
  }
  if (variant === "existing-repository-review") {
    Reflect.set(f.old.serializedContext, workflowKey, fixture().reviewed);
  }
  if (variant === "wrong-app") {
    f.candidate.appId = "foreign";
  }
  if (variant === "wrong-review") {
    f.candidate.originalReviewDigest = "f".repeat(64);
  }
  if (variant === "wrong-repository") {
    f.candidate.repositoryId = "101";
  }
  if (variant === "wrong-pr") {
    f.candidate.pullRequestNumber = 43;
  }
  if (variant === "wrong-head") {
    f.candidate.headSha = "c".repeat(40);
  }
  if (variant === "wrong-source") {
    f.candidate.githubSourceDigest = "f".repeat(64);
  }
  if (variant === "wrong-publication") {
    Object.assign(f.currentContext[workflowKey], {
      publishedGitHubDraftProposalDigest: "f".repeat(64),
    });
  }
  if (variant === "tampered-repair") {
    Reflect.set(f.candidate.publishedOrigin, "digest", "f".repeat(64));
  }
  if (variant === "tampered-publication-receipt") {
    Reflect.set(f.candidate.publicationScope.publication, "digest", "f".repeat(64));
  }
  if (variant === "missing-publication-scope") {
    Reflect.deleteProperty(f.candidate, "publicationScope");
  }
  if (variant === "malformed-review") {
    Reflect.deleteProperty(f.reviewed.reviewReceipt, "changes");
  }
  if (variant === "conflicting-review") {
    const duplicate = structuredClone(f.old);
    const reviewed = z
      .record(z.string(), z.unknown())
      .parse(duplicate.serializedContext[workflowKey]);
    Reflect.set(duplicate.serializedContext, workflowKey, {
      ...reviewed,
      preparedByCallId: "conflicting",
    });
    f.input.payload.candidates.push(duplicate);
  }
  expect(recoverDraftReviewedLineage(f.input)).toBeUndefined();
});

it("recovers the complete original review as lineage without changing workflow, candidate edits or other context", () => {
  const f = fixture();
  const before = structuredClone(f.input);
  expect(recoverDraftReviewedLineage(f.input)).toEqual(f.reviewed);
  expect(f.input).toEqual(before);
  const retried = {
    ...f.input,
    serializedContext: {
      ...f.currentContext,
      [draftReviewedLineageContextKey]: { ...f.candidate, reviewedLineage: f.reviewed },
    },
  };
  expect(recoverDraftReviewedLineage(retried)).toBeUndefined();
});

it("accepts identical complete review contexts at repeated historical checkpoints", () => {
  const f = fixture();
  f.input.payload.candidates.unshift({
    ...structuredClone(f.old),
    origin: { eventId: "earlier-event", slot: 0, stepId: "earlier" },
  });
  expect(recoverDraftReviewedLineage(f.input)).toEqual(f.reviewed);
});

it.each([
  "foreign-owner",
  "foreign-session",
  "changed-source",
  "changed-app",
  "changed-apply",
  "malformed-receipt",
  "compact-receipt",
  "superseding-review",
  "conflicting-slot",
  "selected-context-change",
  "mixed-appspec",
  "mixed-source-receipt",
  "mixed-identity",
  "missing-target",
  "missing-command-root",
])("refuses %s rather than manufacturing review authority", (variant) => {
  const f = fixture();
  if (variant === "mixed-appspec") {
    f.reviewed.appSpec.digest = "f".repeat(64);
  }
  if (variant === "mixed-source-receipt") {
    f.reviewed.sourceReceipt.digest = "f".repeat(64);
  }
  if (variant === "mixed-identity") {
    f.reviewed.identityReceipt.digest = "f".repeat(64);
  }
  if (variant === "missing-target") {
    Reflect.deleteProperty(f.reviewed.proposal, "target");
  }
  if (variant === "missing-command-root") {
    Reflect.deleteProperty(f.reviewed.validationReceipt.commands[0], "validationRoot");
  }
  if (variant === "foreign-owner") {
    f.input.binding.ownerRunId = "foreign";
  }
  if (variant === "foreign-session") {
    Reflect.set(f.input.payload.candidates[0].serializedContext, "eve.sessionId", "foreign");
  }
  if (variant === "changed-source") {
    const source = f.currentContext[workflowKey].githubSource;
    if (source === undefined) {
      throw new Error("Fixture source is absent");
    }
    source.digest = "f".repeat(64);
  }
  if (variant === "changed-app") {
    f.currentContext[workflowKey].appSpec.appId = "foreign";
  }
  if (variant === "changed-apply") {
    f.currentContext[workflowKey].applyReceipt.digest = "f".repeat(64);
  }
  if (variant === "malformed-receipt") {
    f.reviewed.reviewReceipt.digest = "f".repeat(64);
  }
  if (variant === "compact-receipt") {
    Reflect.deleteProperty(f.reviewed.reviewReceipt, "changes");
  }
  if (variant === "superseding-review") {
    f.input.payload.candidates.splice(1, 0, {
      ...structuredClone(f.old),
      origin: { eventId: "new-review-event", slot: 3, stepId: "new-review" },
      serializedContext: {
        ...f.old.serializedContext,
        [workflowKey]: {
          ...f.reviewed,
          reviewReceipt: { ...f.reviewed.reviewReceipt, reviewedByCallId: "new-review" },
        },
      },
    });
  }
  if (variant === "conflicting-slot") {
    f.input.payload.candidates.unshift({
      ...structuredClone(f.old),
      serializedContext: {
        ...f.old.serializedContext,
        [workflowKey]: { ...f.reviewed, preparedByCallId: "other" },
      },
    });
  }
  if (variant === "selected-context-change") {
    f.input.serializedContext = { ...f.currentContext, unrelated: { preserved: false } };
  }
  expect(recoverDraftReviewedLineage(f.input)).toBeUndefined();
});

it("the installed native collector, reconciler and restore path append only the verified lineage", async () => {
  const f = await nativeFixture();
  const result = await recoverTerminalSession(
    {
      auth: { authenticator: "test", principalId: "owner", principalType: "user" },
      descriptor: f.input.descriptor,
      ports: f.ports,
    },
    f.deps,
  );
  expect(result.kind).toBe("accepted");
  const restored = z
    .object({ checkpoint: z.object({ serializedContext: z.record(z.string(), z.unknown()) }) })
    .parse(f.starts[0]);
  expect(restored.checkpoint.serializedContext).toEqual({
    ...f.currentContext,
    [draftReviewedLineageContextKey]: { ...f.candidate, reviewedLineage: f.reviewed },
  });
  const retried = await recoverTerminalSession(
    {
      auth: { authenticator: "test", principalId: "owner", principalType: "user" },
      descriptor: f.input.descriptor,
      ports: f.ports,
    },
    f.deps,
  );
  expect(retried.kind).toBe("accepted");
  expect(f.starts).toHaveLength(1);
});

it("current owner revocation during the recovery port prevents any new native start", async () => {
  const f = await nativeFixture();
  f.ports.applicationStateRecovery.recover = async (input) => {
    const value = recoverDraftReviewedLineage(input);
    f.revoke();
    return value;
  };
  await expect(
    recoverTerminalSession(
      {
        auth: { authenticator: "test", principalId: "owner", principalType: "user" },
        descriptor: f.input.descriptor,
        ports: f.ports,
      },
      f.deps,
    ),
  ).rejects.toThrow("owner revoked");
  expect(f.starts).toHaveLength(0);
});

it("the SDK refuses an application recovery registration targeting its own session identity", async () => {
  const f = await nativeFixture();
  f.ports.applicationStateRecovery.contextKey = "eve.sessionId";
  const result = await recoverTerminalSession(
    {
      auth: { authenticator: "test", principalId: "owner", principalType: "user" },
      descriptor: f.input.descriptor,
      ports: f.ports,
    },
    f.deps,
  );
  expect(result).toEqual({
    kind: "unavailable",
    reason: "application-state-recovery-configuration",
  });
  expect(f.starts).toHaveLength(0);
});

it("the SDK never overwrites an existing candidate field through the recovery hook", async () => {
  const f = await nativeFixture();
  f.ports.applicationStateRecovery.field = "unpublished";
  f.ports.applicationStateRecovery.recover = async () => {
    throw new Error("existing fields must not reach the callback");
  };
  const result = await recoverTerminalSession(
    {
      auth: { authenticator: "test", principalId: "owner", principalType: "user" },
      descriptor: f.input.descriptor,
      ports: f.ports,
    },
    f.deps,
  );
  expect(result.kind).toBe("accepted");
  const restored = z
    .object({ checkpoint: z.object({ serializedContext: z.record(z.string(), z.unknown()) }) })
    .parse(f.starts[0]);
  expect(restored.checkpoint.serializedContext).toEqual(f.currentContext);
});
