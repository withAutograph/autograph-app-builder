/* oxlint-disable sonarjs/no-internal-api-use -- Qualify the installed framework actual negative-outcome classifier, never a mirrored status table. */
import { resolveApprovalOutcome } from "../../node_modules/eve/dist/src/harness/input-request-resolution.js";
/* oxlint-disable eslint/no-await-in-loop -- Native request, resolution and result order is the subject of these actual hook tests. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- Only framework callback session ID is consumed; no I/O or mutation capability is supplied. */
/* oxlint-disable sonarjs/no-internal-api-use -- Exercise actual installed Eve state, never a mocked authority store. */
import { describe, it, expect } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import hook from "../../agent/hooks/retain-private-apply-decisions";
import type { HookContext } from "eve/hooks";
import {
  requestPrivateApplyApproval,
  recordApprovedPrivateApply,
  readPrivateApplyAuthority,
  assertNoPendingPrivateApplyApproval,
} from "./private-apply-authority";
import { privateApplyDenialEvents } from "../eve/private-apply-denial.test-fixture";
import { observePrivateApplyDenials } from "../eve/private-apply-denial-evidence";

const observe = (values: ReturnType<typeof privateApplyDenialEvents>) =>
  observePrivateApplyDenials({ sessionId: "owned", calls: ["denied-call"], events: values });

const scope = {
  appId: "app",
  appSpecDigest: "spec",
  proposalDigest: "old-default",
  sessionId: "owned",
  workspaceId: "workspace",
};
// SAFETY: The hook only consumes the actual session ID; no I/O or channel mutation is available.
const ctx = { session: { id: "owned" } } as HookContext;
describe("genuine private Build denial lifecycle", () => {
  it("retires only a real paired denial and preserves both the newer grant and terminal evidence", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      requestPrivateApplyApproval(scope, "denied-call");
      const approved = { ...scope, proposalDigest: "new-approved" };
      requestPrivateApplyApproval(approved, "accepted-call");
      recordApprovedPrivateApply(approved, "accepted-call");
      const events = privateApplyDenialEvents();
      for (const event of events) {
        if (event.type === "input.requested") {
          await hook.events?.["input.requested"]?.(event, ctx);
        }
        if (event.type === "input.resolved") {
          await hook.events?.["input.resolved"]?.(event, ctx);
        }
        if (event.type === "action.result") {
          await hook.events?.["action.result"]?.(event, ctx);
        }
      }
      expect(() => {
        assertNoPendingPrivateApplyApproval();
      }).not.toThrow();
      expect(readPrivateApplyAuthority().grant).toEqual(approved);
      expect(readPrivateApplyAuthority().terminalDecisions).toMatchObject([
        {
          callId: "denied-call",
          eventIds: ["request-event", "resolution-event", "result-event"],
          outcome: "denied-not-run",
          scope,
        },
      ]);
    });
  });
  it("does not retire authority from a missing response, foreign session, generic failure or approved contradiction", async () => {
    for (const variant of ["missing", "foreign", "failure", "approved"]) {
      await contextStorage.run(new ContextContainer(), async () => {
        requestPrivateApplyApproval(scope, "denied-call");
        const events = privateApplyDenialEvents();
        for (const event of events) {
          const context =
            variant === "foreign" ? { ...ctx, session: { ...ctx.session, id: "other" } } : ctx;
          if (event.type === "input.requested") {
            await hook.events?.["input.requested"]?.(event, context);
          }
          if (event.type === "input.resolved" && variant !== "missing") {
            await hook.events?.["input.resolved"]?.(
              variant === "approved"
                ? {
                    ...event,
                    data: {
                      ...event.data,
                      resolutions: [
                        { kind: "tool-approval", requestId: "denied-request", outcome: "approved" },
                      ],
                    },
                  }
                : event,
              context,
            );
          }
          if (event.type === "action.result") {
            await hook.events?.["action.result"]?.(
              variant === "failure"
                ? { ...event, data: { ...event.data, status: "failed" } }
                : event,
              context,
            );
          }
        }
        expect(() => {
          assertNoPendingPrivateApplyApproval();
        }).toThrow();
        expect(readPrivateApplyAuthority().terminalDecisions).toBeUndefined();
      });
    }
  });
  it("history catch-up rejects incomplete, contradictory and reordered outcomes", () => {
    const events = privateApplyDenialEvents();
    expect(observe(events)).toHaveLength(1);
    expect(observe(events.filter((e) => e.type !== "input.resolved"))).toEqual([]);
    expect(observe(events.toReversed())).toEqual([]);
    const approved = events.map((e) =>
      e.type === "input.resolved"
        ? {
            ...e,
            meta: { ...e.meta, id: "contradiction" },
            data: {
              ...e.data,
              resolutions: [
                {
                  kind: "tool-approval" as const,
                  requestId: "denied-request",
                  outcome: "approved" as const,
                },
              ],
            },
          }
        : e,
    );
    expect(observe([...events, ...approved])).toEqual([]);
  });
});

it.each(["ignored", "invalid"] as const)(
  "uses actual framework %s outcome with not_run proof, without authorizing it",
  async (status) => {
    const actual = resolveApprovalOutcome(
      status === "ignored"
        ? undefined
        : { requestId: "denied-request", optionId: "not-a-valid-approval" },
    );
    expect(actual.approved).toBe(false);
    expect(actual.status).toBe(status);
    expect(
      observePrivateApplyDenials({
        sessionId: "owned",
        calls: ["denied-call"],
        events: privateApplyDenialEvents("denied-call", "denied-request", status),
      }),
    ).toMatchObject([{ outcome: `${status}-not-run` }]);
    await contextStorage.run(new ContextContainer(), async () => {
      requestPrivateApplyApproval(scope, "denied-call");
      for (const event of privateApplyDenialEvents("denied-call", "denied-request", status)) {
        if (event.type === "input.requested") {
          await hook.events?.["input.requested"]?.(event, ctx);
        }
        if (event.type === "input.resolved") {
          await hook.events?.["input.resolved"]?.(event, ctx);
        }
        if (event.type === "action.result") {
          await hook.events?.["action.result"]?.(event, ctx);
        }
      }
      expect(readPrivateApplyAuthority().pending).toEqual([]);
      expect(readPrivateApplyAuthority().grant).toBeNull();
      expect(readPrivateApplyAuthority().terminalDecisions?.[0]?.outcome).toBe(`${status}-not-run`);
    });
  },
);
