import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  hasSettledGitHubDeliveryEffects,
  readSettledGitHubDeliveryRepeat,
} from "./native-recovery-github-delivery-effects";

type Json = z.infer<ReturnType<typeof z.json>>;

const callId = "reviewed-delivery-call";
const logicalSessionId = "retained-builder-session";
const appId = "socket-label-log";
const toolName = "finish-github-pr-delivery";
const mergeCommitSha = "c".repeat(40);
const readyAt = "2026-11-13T01:14:00.000Z";
const approval = {
  baseBranch: "main",
  headSha: "a".repeat(40),
  installationId: "42",
  name: "arrusted-development",
  owner: "withAutograph",
  proposalDigest: "b".repeat(64),
  pullRequestNumber: 1810,
  repositoryId: "100",
};
const destination = {
  repositoryId: approval.repositoryId,
  repositoryFullName: `${approval.owner}/${approval.name}`,
};
const schemaActivation = { deliveryCallId: callId, mergeIntentDigest: "d".repeat(64) };
const activation = {
  ...schemaActivation,
  mergeSha: mergeCommitSha,
  reviewedHeadSha: approval.headSha,
};
const merged = {
  status: "merged",
  mergeCommitSha,
  nativeProductionTarget: { appId, ...destination },
};
const mergedWithSchema = { ...merged, schemaActivation };
const live = {
  version: 1,
  appId,
  observedAt: "2026-11-13T01:20:00.000Z",
  status: "available",
  destination,
  deployment: { state: "active" },
  app: { state: "sign-in-required", url: "https://apps.autograph.so/socket-label-log" },
  requestedRevision: "live",
};
const pending = { ...live, status: "pending", requestedRevision: "awaiting-activation" };
const context = { callId, toolName, session: { id: logicalSessionId } };
const step = (name: string, output: Json, args: readonly Json[]) => ({
  name,
  args: [{ args, context, contextIndexes: [1] }],
  output: { kind: "result", output, authorized: [] },
});
const delivery = (output: Json) => step("continueGitHubPrDelivery", output, [approval, null]);
const ready = delivery({ status: "waiting-for-checks", readyAt });
const merge = (output: Json) => step("continueGitHubPrDelivery", output, [approval, null, readyAt]);
const schema = (output: Json, reviewedActivation = activation) =>
  step("continueGitHubProductionSchema", output, [approval, null, reviewedActivation]);
const prove = (
  completedSteps: Parameters<typeof hasSettledGitHubDeliveryEffects>[0]["completedSteps"],
  schemaChangeExpected = true,
) =>
  hasSettledGitHubDeliveryEffects({
    callId,
    logicalSessionId,
    appId,
    toolInput: approval,
    schemaChangeExpected,
    completedSteps,
  });

describe("retained GitHub delivery effects", () => {
  it("recognizes the reviewed merge and the exact schema activation after an earlier pending read", () => {
    expect(prove([ready, merge(mergedWithSchema), schema(pending), schema(live)])).toBe(true);
  });

  it("recognizes a completed merge with no authorized schema change", () => {
    expect(prove([ready, merge(merged)], false)).toBe(true);
    expect(prove([delivery({ status: "merged", mergeCommitSha })], false)).toBe(true);
    expect(prove([ready, merge(merged)])).toBe(false);
  });

  it("does not treat post-Stop work as the stopped call's own proof", () => {
    expect(prove([ready, merge(mergedWithSchema), { ...schema(live), afterStop: true }])).toBe(
      false,
    );
    expect(prove([{ ...delivery(merged), afterStop: true }], false)).toBe(false);
  });

  it("requires the final schema-aware read even if the provider has activated the requested revision", () => {
    const providerOnly = {
      ...live,
      deployment: { ...live.deployment, requestedRevisionActive: true },
    };
    expect(prove([ready, merge(mergedWithSchema), schema(providerOnly)])).toBe(false);
    expect(prove([ready, merge(mergedWithSchema), schema(pending)])).toBe(false);
    expect(prove([ready, merge(mergedWithSchema)])).toBe(false);
  });

  it.each([
    { ...activation, deliveryCallId: "another-call" },
    { ...activation, mergeSha: "e".repeat(40) },
    { ...activation, mergeIntentDigest: "e".repeat(64) },
    { ...activation, reviewedHeadSha: "e".repeat(40) },
  ])("rejects activation evidence from another approval, merge, intent or head", (changed) => {
    expect(prove([ready, merge(mergedWithSchema), schema(live, changed)])).toBe(false);
  });

  it("rejects a merge receipt with another call's activation", () => {
    const changed = { ...schemaActivation, deliveryCallId: "another-call" };
    expect(
      prove([
        ready,
        merge({ ...merged, schemaActivation: changed }),
        schema(live, {
          ...activation,
          ...changed,
        }),
      ]),
    ).toBe(false);
  });

  it.each([
    { ...context, callId: "another-call" },
    { ...context, toolName: "other-tool" },
    { ...context, session: { id: "other-session" } },
  ])("requires the exact retained workflow context", (changed) => {
    const other = schema(live);
    const [wrapper] = other.args;
    expect(
      prove([
        ready,
        merge(mergedWithSchema),
        { ...other, args: [{ ...wrapper, context: changed }] },
      ]),
    ).toBe(false);
  });

  it("rejects later delivery or uncertain schema work after an apparent completion", () => {
    const deliverySteps = [ready, merge(mergedWithSchema), schema(live)];
    expect(prove([...deliverySteps, merge({ status: "merge-unconfirmed" })])).toBe(false);
    expect(prove([...deliverySteps, schema(pending)])).toBe(false);
    expect(
      prove([
        ready,
        merge(mergedWithSchema),
        { ...schema(live), output: { kind: "authorization-required" } },
      ]),
    ).toBe(false);
  });

  it("requires exact approved repository input, ready cycle, and observed app", () => {
    const changedHead = step("continueGitHubPrDelivery", merged, [
      { ...approval, headSha: "e".repeat(40) },
      null,
      readyAt,
    ]);
    const changedCycle = step("continueGitHubPrDelivery", merged, [
      approval,
      null,
      "2026-11-13T01:16:00.000Z",
    ]);
    expect(prove([ready, changedHead], false)).toBe(false);
    expect(prove([ready, changedCycle], false)).toBe(false);
    expect(prove([ready, merge(mergedWithSchema), schema({ ...live, appId: "another-app" })])).toBe(
      false,
    );
    expect(
      prove([
        ready,
        merge(mergedWithSchema),
        schema({ ...live, destination: { ...destination, repositoryId: "101" } }),
      ]),
    ).toBe(false);
  });
});

describe("repeat GitHub delivery effects", () => {
  const prior = { ...schemaActivation, deliveryCallId: "earlier-delivery" };
  const priorActivation = { ...activation, ...prior };
  const repeatApproval = { ...approval, readyAt };
  const repeatMerge = step("continueGitHubPrDelivery", { ...merged, schemaActivation: prior }, [
    repeatApproval,
    null,
  ]);
  const repeatSchema = (output: Json, reviewedActivation = priorActivation) =>
    step("continueGitHubProductionSchema", output, [repeatApproval, null, reviewedActivation]);
  const readRepeat = (
    completedSteps: Parameters<typeof readSettledGitHubDeliveryRepeat>[0]["completedSteps"],
    overrides: Partial<Parameters<typeof readSettledGitHubDeliveryRepeat>[0]> = {},
  ) =>
    readSettledGitHubDeliveryRepeat({
      callId,
      logicalSessionId,
      appId,
      toolInput: repeatApproval,
      schemaChangeExpected: true,
      completedSteps,
      ...overrides,
    });

  it("identifies the exact older merge receipt after one completed read of the merged PR", () => {
    expect(readRepeat([repeatMerge])).toEqual({ ...prior, mergeSha: mergeCommitSha, readyAt });
    expect(
      readRepeat([delivery({ ...merged, schemaActivation: prior })], { toolInput: approval }),
    ).toEqual({ ...prior, mergeSha: mergeCommitSha });
    expect(prove([delivery({ ...merged, schemaActivation: prior })])).toBe(false);
  });

  it("binds schema polling to the retained activation for the same earlier merge", () => {
    const providerPending = {
      ...pending,
      deployment: { ...pending.deployment, requestedRevisionActive: true },
    };
    expect(readRepeat([repeatMerge, repeatSchema(providerPending)])).toEqual({
      ...prior,
      mergeSha: mergeCommitSha,
      readyAt,
    });
    expect(readRepeat([repeatMerge, repeatSchema(pending), repeatSchema(live)])).toEqual({
      ...prior,
      mergeSha: mergeCommitSha,
      readyAt,
    });
    expect(readRepeat([repeatMerge, repeatSchema(live), repeatSchema(pending)])).toBeNull();
    expect(
      readRepeat([repeatMerge, repeatSchema({ ...live, deployment: providerPending.deployment })]),
    ).toBeNull();
  });

  it("recognizes the exact final stopped status only for a read of an earlier merge", () => {
    const stopped = { status: "monitoring-stopped", requestedRevision: "unassessed" };
    expect(readRepeat([repeatMerge, repeatSchema(stopped)])).toEqual({
      ...prior,
      mergeSha: mergeCommitSha,
      readyAt,
    });
    expect(readRepeat([repeatMerge, repeatSchema(stopped), repeatSchema(pending)])).toBeNull();
    expect(readRepeat([repeatMerge, repeatSchema({ ...stopped, extra: true })])).toBeNull();
  });

  it("identifies a repeat with one exact final post-Stop schema step", () => {
    const stopped = { status: "monitoring-stopped", requestedRevision: "unassessed" };
    const late = { ...repeatSchema(stopped), afterStop: true } as const;
    expect(readRepeat([repeatMerge, repeatSchema(pending), late])).toEqual({
      ...prior,
      mergeSha: mergeCommitSha,
      readyAt,
    });
    expect(readRepeat([repeatMerge, late, repeatSchema(pending)])).toBeNull();
    expect(readRepeat([repeatMerge, late, late])).toBeNull();
    expect(readRepeat([{ ...repeatMerge, afterStop: true }, late])).toBeNull();
    expect(
      readRepeat([
        repeatMerge,
        {
          ...late,
          args: repeatSchema(stopped, { ...priorActivation, mergeSha: "e".repeat(40) }).args,
        },
      ]),
    ).toBeNull();
  });

  it.each(["failed", "cancelled"] as const)(
    "permits one final exact %s schema step with no output",
    (status) => {
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Native terminal steps keep the output property without a value.
      const terminal = { ...repeatSchema(pending), status, output: undefined };
      expect(readRepeat([repeatMerge, repeatSchema(pending), terminal])).toEqual({
        ...prior,
        mergeSha: mergeCommitSha,
        readyAt,
      });
      expect(readRepeat([repeatMerge, terminal, repeatSchema(pending)])).toBeNull();
      expect(readRepeat([repeatMerge, terminal, terminal])).toBeNull();
      expect(readRepeat([repeatMerge, { ...repeatSchema(live), status }])).toBeNull();
      expect(
        readRepeat([{ ...terminal, name: repeatMerge.name, args: repeatMerge.args }]),
      ).toBeNull();
      expect(
        readRepeat([
          repeatMerge,
          {
            ...terminal,
            args: repeatSchema(pending, { ...priorActivation, reviewedHeadSha: "e".repeat(40) })
              .args,
          },
        ]),
      ).toBeNull();
    },
  );

  it("rejects a current, unconfirmed or repeated merge, a Ready step, and any unknown effect", () => {
    const waiting = step("continueGitHubPrDelivery", { status: "waiting-for-checks", readyAt }, [
      repeatApproval,
      null,
    ]);
    expect(readRepeat([waiting, repeatMerge])).toBeNull();
    expect(readRepeat([repeatMerge, repeatMerge])).toBeNull();
    expect(
      readRepeat([step("continueGitHubPrDelivery", mergedWithSchema, [repeatApproval, null])]),
    ).toBeNull();
    expect(readRepeat([{ ...repeatMerge, output: { kind: "result", output: {} } }])).toBeNull();
    expect(
      readRepeat([repeatMerge, { ...repeatSchema(pending), name: "unknown-step" }]),
    ).toBeNull();
    expect(readRepeat([repeatMerge], { schemaChangeExpected: false })).toBeNull();
  });

  it("rejects a different child call, application, repository or reviewed approval", () => {
    const otherContext = { ...context, callId: prior.deliveryCallId };
    const [wrapper] = repeatMerge.args;
    expect(
      readRepeat([{ ...repeatMerge, args: [{ ...wrapper, context: otherContext }] }]),
    ).toBeNull();
    expect(readRepeat([repeatMerge], { appId: "another-app" })).toBeNull();
    expect(
      readRepeat([repeatMerge], { toolInput: { ...repeatApproval, repositoryId: "101" } }),
    ).toBeNull();
    expect(
      readRepeat([repeatMerge, repeatSchema({ ...pending, appId: "another-app" })]),
    ).toBeNull();
    expect(
      readRepeat([
        repeatMerge,
        repeatSchema(pending, { ...priorActivation, mergeSha: "e".repeat(40) }),
      ]),
    ).toBeNull();
  });
});
