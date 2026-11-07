/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, typescript/consistent-type-imports -- SAFETY: Each partial native event fixture supplies only fields consumed by the actual hooks; provider and app mutation ports are absent. */
/* oxlint-disable anti-slop/no-module-mocking, sonarjs/no-internal-api-use -- Actual Eve state and native denial/inspection hooks run; only durable persistence is replaced with an in-context diagnostic store. */
/* oxlint-disable typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- SAFETY: Fixtures supply consumed native session coordinates and immutable workflow fields; no Sandbox/provider/effect port exists. */
import { describe, expect, it, vi } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import type { HookContext } from "eve/hooks";
import type { ToolContext } from "eve/tools";
import { appBuilderWorkflowState, sha256 } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import {
  requestPrivateApplyApproval,
  readPrivateApplyAuthority,
  recordApprovedPrivateApply,
} from "./private-apply-authority";
import { observePrivateApplyDecisionEvent } from "./private-apply-decision-lifecycle";
import { privateApplyDenialEvents } from "../eve/private-apply-denial.test-fixture";
import { inspectCurrentProposalSource } from "./proposed-source-inspection";
import {
  observePlannedAuthoringRequest,
  observePlannedAuthoringInspection,
  currentPlannedAuthoringCorrection,
} from "./planned-proposal-authoring";
import {
  currentAuthoringDecision,
  diagnosticAuthoringDecisionState,
  authenticatedAuthoringDelivery,
} from "./preapproval-authoring-runtime";
import { preapprovalAuthoringDecisionSchema } from "./preapproval-authoring";
import applyAppCreation from "../../agent/tools/apply_app_creation";
import authoringHook from "../../agent/hooks/continue-preapproval-authoring";
import requestHook from "../../agent/hooks/retain-product-request";

vi.mock("./preapproval-authoring-runtime", async (original) => {
  const actual = await original<typeof import("./preapproval-authoring-runtime")>();
  return {
    ...actual,
    recordPreapprovalAuthoringDecision: async (
      _ctx: Pick<HookContext, "session">,
      decision: Parameters<typeof actual.recordPreapprovalAuthoringDecision>[1],
    ) => {
      actual.diagnosticAuthoringDecisionState.update(() => decision);
    },
  };
});
const ctx = (turnId = "correction", sequence = 2): HookContext =>
  ({
    session: { id: "owned", turn: { id: turnId, sequence } },
  }) as HookContext;
const hash = (letter: string) => letter.repeat(64);
const seed = () => {
  const changes = [
    {
      after: {
        content: "draft",
        digest: sha256("draft"),
        mode: "644",
      },
      path: "apps/example/app/page.tsx",
    },
  ];
  const contract = {
    appId: "example",
    appSpec: { path: "app-spec.md", sha256: hash("a") },
    version: 1,
  };
  const unsigned = {
    appSpecDigest: hash("a"),
    contractDigest: sha256(JSON.stringify(contract)),
    plannedByCallId: "actual-plan",
    sourceReceiptDigest: hash("c"),
    target: {
      contract,
      iteration: {
        changes,
        digest: sha256(JSON.stringify(changes)),
      },
      operation: "iterate-existing-app",
    },
    version: 1,
    workspaceDigest: hash("b"),
  };
  const current = {
    appSpec: {
      acceptedByCallId: "actual-accept",
      appId: "example",
      artifactPath: "app-spec.md",
      artifactRevision: "accepted-revision",
      digest: hash("a"),
    },
    artifacts: [],
    identityReceipt: { identity: { appId: "example" } },
    phase: "planned",
    proposal: { ...unsigned, digest: sha256(JSON.stringify(unsigned)) },
    sourceReceipt: { digest: hash("c") },
    version: 17,
    workspace: { workspaceDigest: hash("b"), workspaceId: "sandbox" },
  } as unknown as Extract<AppBuilderWorkflowState, { phase: "planned" }>;
  appBuilderWorkflowState.update(() => current);
  return current;
};
const scope = (current: ReturnType<typeof seed>) => ({
  appId: "example",
  appSpecDigest: current.appSpec.digest,
  proposalDigest: current.proposal.digest,
  sessionId: "owned",
  workspaceId: "sandbox",
});
const deny = (current: ReturnType<typeof seed>) => {
  requestPrivateApplyApproval(scope(current), "denied-call");
  for (const event of privateApplyDenialEvents()) {
    // SAFETY: The fixture consists of the exact documented three native denial lifecycle events.
    observePrivateApplyDecisionEvent(
      event as Parameters<typeof observePrivateApplyDecisionEvent>[0],
      "owned",
    );
  }
};
const request = (owner = ctx()) => {
  observePlannedAuthoringRequest(owner, {
    message: "Correct the current draft and tests before asking for fresh Build.",
    sequence: 0,
    turnId: owner.session.turn.id,
  });
};
const inspection = (current: ReturnType<typeof seed>, owner = ctx(), callId = "actual-inspect") => {
  const output = inspectCurrentProposalSource(
    {
      appId: "example",
      expectedProposalDigest: current.proposal.digest,
      pathIndex: 0,
      paths: [],
    },
    owner as unknown as Pick<ToolContext, "session" | "abortSignal">,
  );
  return {
    data: {
      result: {
        callId,
        kind: "tool-result",
        output,
        toolName: "inspect_existing_app",
      },
      status: "completed",
    },
    type: "action.result",
  } as unknown as Parameters<typeof observePlannedAuthoringInspection>[0];
};
const run = <T>(operation: () => T): T => contextStorage.run(new ContextContainer(), operation);
const decision = (owner = ctx()) =>
  currentAuthoringDecision(owner, {
    blocked: false,
    completed: true,
    pendingInput: false,
  });

describe("declined current-proposal drafting observation", () => {
  it("binds a genuine later user message and actual successful inspection without touching denial or grant", () => {
    run(() => {
      const current = seed();
      deny(current);
      const authority = readPrivateApplyAuthority();
      expect(currentPlannedAuthoringCorrection(ctx())).toBeUndefined();
      request();
      expect(decision().decision).toBe("planned");
      observePlannedAuthoringInspection(inspection(current), ctx());
      const observed = decision();
      expect(observed.decision).toBe("runnable");
      expect(observed.scope?.correction).toMatchObject({
        denialEvidenceDigest: authority.terminalDecisions?.[0]?.evidenceDigest,
        inspectionCallId: "actual-inspect",
        proposalDigest: current.proposal.digest,
        requestTurnId: "correction",
      });
      expect(preapprovalAuthoringDecisionSchema.parse(observed)).toEqual(observed);
      expect(readPrivateApplyAuthority()).toEqual(authority);
      expect(appBuilderWorkflowState.get()).toEqual(current);
    });
  });
  it("never arms denial alone, a pre-denial user message, or inspection-only activity", () => {
    run(() => {
      const current = seed();
      request();
      deny(current);
      observePlannedAuthoringInspection(inspection(current), ctx());
      expect(decision().decision).toBe("planned");
    });
  });
  it.each(["missing", "foreign", "granted", "pending"] as const)("blocks %s authority", (mode) => {
    run(() => {
      const current = seed();
      if (mode !== "missing") {
        deny(current);
      }
      if (mode === "granted") {
        requestPrivateApplyApproval(scope(current), "approved");
        recordApprovedPrivateApply(scope(current), "approved");
      }
      if (mode === "pending") {
        requestPrivateApplyApproval({ ...scope(current), proposalDigest: "other" }, "pending");
      }
      const owner =
        mode === "foreign"
          ? ({ ...ctx(), session: { ...ctx().session, id: "foreign" } } as HookContext)
          : ctx();
      request(owner);
      if (mode !== "granted") {
        observePlannedAuthoringInspection(inspection(current, owner), owner);
      }
      expect(decision(owner).decision).not.toBe("runnable");
    });
  });
  it.each(["failed", "isError", "other-turn", "other-proposal"] as const)(
    "requires a genuine successful same-turn matching inspection: %s",
    (mode) => {
      run(() => {
        const current = seed();
        deny(current);
        request();
        const event = inspection(current);
        if (mode === "failed") {
          event.data.status = "failed";
        }
        if (mode === "isError" && event.data.result.kind === "tool-result") {
          event.data.result.isError = true;
        }
        if (mode === "other-proposal" && event.data.result.kind === "tool-result") {
          event.data.result.output = {
            appId: "example",
            proposalDigest: "other",
            source: "current-proposal",
            status: "UNAPPLIED",
          };
        }
        observePlannedAuthoringInspection(event, mode === "other-turn" ? ctx("other", 3) : ctx());
        expect(decision().decision).toBe("planned");
      });
    },
  );
  it("keeps the first inspection stable and disables correction for successor or source drift", () => {
    run(() => {
      const current = seed();
      deny(current);
      request();
      observePlannedAuthoringInspection(inspection(current), ctx());
      const first = decision();
      observePlannedAuthoringInspection(inspection(current, ctx(), "another-read"), ctx());
      expect(decision().scopeDigest).toBe(first.scopeDigest);
      appBuilderWorkflowState.update(() => ({
        ...current,
        sourceReceipt: { ...current.sourceReceipt, digest: "f".repeat(64) },
      }));
      expect(decision().decision).not.toBe("runnable");
      appBuilderWorkflowState.update(() => ({
        ...current,
        proposal: { ...current.proposal, digest: "e".repeat(64) },
      }));
      expect(decision().decision).toBe("planned");
    });
  });
  it("uses the actual request and authoring hooks and blocks an unchanged internal correction turn", async () => {
    await run(async () => {
      const current = seed();
      deny(current);
      const owner = ctx();
      // SAFETY: These are the native hook fields consumed by retention; no model/provider port is present.
      await requestHook.events?.["message.received"]?.(
        {
          data: {
            message: "Correct this unapproved draft",
            sequence: 0,
            turnId: owner.session.turn.id,
          },
        } as never,
        owner,
      );
      await authoringHook.events?.["turn.started"]?.({} as never, owner);
      await authoringHook.events?.["action.result"]?.(inspection(current), owner);
      await authoringHook.events?.["turn.completed"]?.({} as never, owner);
      const first = diagnosticAuthoringDecisionState.get();
      expect(first?.decision).toBe("runnable");
      if (first?.scopeDigest === undefined) {
        throw new Error("Missing genuine correction scope");
      }
      const retainedScopeDigest = first.scopeDigest;
      const internal = ctx("internal", 3);
      authenticatedAuthoringDelivery.update(() => ({
        scopeDigest: retainedScopeDigest,
        turnId: "internal",
      }));
      await authoringHook.events?.["turn.started"]?.({} as never, internal);
      await authoringHook.events?.["action.result"]?.(
        inspection(current, internal, "repeat-read"),
        internal,
      );
      await authoringHook.events?.["turn.completed"]?.({} as never, internal);
      expect(diagnosticAuthoringDecisionState.get()).toMatchObject({
        decision: "blocked",
        reason: "authoring_no_progress",
      });
      expect(readPrivateApplyAuthority().grant).toBeNull();
    });
  });
  it.each(["failed", "pendingInput", "cancelled"] as const)(
    "preserves the actual %s boundary after a legitimate correction inspection",
    async (mode) => {
      await run(async () => {
        const current = seed();
        deny(current);
        request();
        const owner = ctx();
        await authoringHook.events?.["turn.started"]?.({} as never, owner);
        await authoringHook.events?.["action.result"]?.(inspection(current), owner);
        if (mode === "failed") {
          const failure = inspection(current, owner, "failed-read");
          failure.data.status = "failed";
          if (failure.data.result.kind === "tool-result") {
            failure.data.result.isError = true;
          }
          await authoringHook.events?.["action.result"]?.(failure, owner);
        }
        if (mode === "pendingInput") {
          await authoringHook.events?.["input.requested"]?.(
            { data: { requests: [{ requestId: "question" }] } } as never,
            owner,
          );
        }
        await (mode === "cancelled"
          ? authoringHook.events?.["turn.cancelled"]?.({} as never, owner)
          : authoringHook.events?.["turn.completed"]?.({} as never, owner));
        expect(diagnosticAuthoringDecisionState.get()?.decision).not.toBe("runnable");
      });
    },
  );
  it("does not transfer the declined correction to a genuine successor proposal or its new pending Build", () => {
    run(() => {
      const current = seed();
      deny(current);
      request();
      observePlannedAuthoringInspection(inspection(current), ctx());
      expect(decision().decision).toBe("runnable");
      // oxlint-disable-next-line sonarjs/no-unused-vars -- Exclude the prior digest before constructing the independently hashed successor.
      const { digest: _prior, ...unsigned } = current.proposal;
      const successor = { ...unsigned, plannedByCallId: "successor-call" };
      const proposal = { ...successor, digest: sha256(JSON.stringify(successor)) };
      appBuilderWorkflowState.update(() => ({ ...current, proposal }));
      expect(decision().decision).toBe("planned");
      requestPrivateApplyApproval(
        { ...scope(current), proposalDigest: proposal.digest },
        "new-build",
      );
      expect(decision().decision).toBe("waiting-input");
      expect(readPrivateApplyAuthority().grant).toBeNull();
      expect(readPrivateApplyAuthority().terminalDecisions?.[0]?.scope.proposalDigest).toBe(
        current.proposal.digest,
      );
    });
  });
  it("rejects a substituted replay of the same real user event instead of resetting the inspection fence", () => {
    run(() => {
      const current = seed();
      deny(current);
      request();
      observePlannedAuthoringInspection(inspection(current), ctx());
      expect(decision().decision).toBe("runnable");
      observePlannedAuthoringRequest(ctx(), {
        message: "different bytes",
        sequence: 0,
        turnId: "correction",
      });
      expect(decision().decision).toBe("planned");
      expect(readPrivateApplyAuthority().grant).toBeNull();
    });
  });
  it.each(["internal-unchanged", "fresh-external", "internal-successor"] as const)(
    "uses actual apply approval without replay or consent transfer: %s",
    async (mode) => {
      await run(async () => {
        const current = seed();
        deny(current);
        request();
        observePlannedAuthoringInspection(inspection(current), ctx());
        const original = decision();
        if (original.scopeDigest === undefined) {
          throw new Error("Missing correction binding");
        }
        const originalScopeDigest = original.scopeDigest;
        const owner = ctx(mode === "fresh-external" ? "new-user" : "internal", 3);
        if (mode !== "fresh-external") {
          authenticatedAuthoringDelivery.update(() => ({
            scopeDigest: originalScopeDigest,
            turnId: "internal",
          }));
        }
        if (mode === "internal-successor") {
          // oxlint-disable-next-line sonarjs/no-unused-vars -- Recompute the genuine successor digest without its predecessor hash.
          const { digest: _old, ...unsigned } = current.proposal;
          const successor = { ...unsigned, plannedByCallId: "successor-call" };
          appBuilderWorkflowState.update(() => ({
            ...current,
            proposal: { ...successor, digest: sha256(JSON.stringify(successor)) },
          }));
        }
        const policy = applyAppCreation.approval;
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Narrow the actual SDK function-or-configuration approval API.
        if (typeof policy !== "function") {
          throw new TypeError("Expected actual apply approval policy");
        }
        const input = {
          ...owner,
          abortSignal: new AbortController().signal,
          callId: "next-apply",
          toolInput: {},
        };
        expect(await policy(input as never)).toBe(
          mode === "internal-unchanged" ? "not-applicable" : "user-approval",
        );
        if (mode === "internal-unchanged") {
          await expect(
            applyAppCreation.execute({ implementationFiles: [] }, input as never),
          ).resolves.toMatchObject({ status: "corrected_proposal_required" });
          expect(readPrivateApplyAuthority().pending).toEqual([]);
        } else {
          expect(readPrivateApplyAuthority().pending).toMatchObject([{ callId: "next-apply" }]);
        }
        expect(readPrivateApplyAuthority().grant).toBeNull();
        expect(readPrivateApplyAuthority().terminalDecisions?.[0]?.scope.proposalDigest).toBe(
          current.proposal.digest,
        );
      });
    },
  );
});
