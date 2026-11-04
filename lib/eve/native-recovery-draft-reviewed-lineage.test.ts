/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, eslint/require-await -- Installed SDK private runtime APIs remain opaque; synthetic hooks preserve their asynchronous contract. */
/* oxlint-disable anti-slop/no-unknown-parameters -- Installed SDK fixtures accept opaque native storage values. */
import { expect, it } from "vitest";
import { z } from "zod";
import {
  recoverDraftReviewedLineage,
  draftReviewedLineageContextKey,
} from "./native-recovery-draft-reviewed-lineage";
import {
  fixture,
  nativeFixture,
  recoverTerminalSession,
  workflowKey,
} from "./test-support/draft-reviewed-recovery";

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
    origin: { slot: 0, stepId: "earlier", eventId: "earlier-event" },
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
      origin: { slot: 3, stepId: "new-review", eventId: "new-review-event" },
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
      auth: { authenticator: "test", principalType: "user", principalId: "owner" },
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
      auth: { authenticator: "test", principalType: "user", principalId: "owner" },
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
        auth: { authenticator: "test", principalType: "user", principalId: "owner" },
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
      auth: { authenticator: "test", principalType: "user", principalId: "owner" },
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
      auth: { authenticator: "test", principalType: "user", principalId: "owner" },
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
