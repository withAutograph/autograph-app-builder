/* oxlint-disable sonarjs/no-internal-api-use -- Test actual installed Eve persistence boundaries; these runtime internals are never imported by product code. */
import { describe, expect, it } from "vitest";
// Exercise Eve's actual durable state storage and serialization, not a mock state handle.
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import {
  deserializeContext,
  serializeContext,
} from "../../node_modules/eve/dist/src/context/serialize.js";
import { recordApprovedPrivateApply, requestPrivateApplyApproval } from "./private-apply-authority";

const scope = {
  appId: "builder",
  appSpecDigest: "spec",
  proposalDigest: "proposal",
  sessionId: "session",
  workspaceId: "private-workspace",
};

describe("private apply approval scope", () => {
  it("retains approval through an execution error and a serialized Eve turn boundary", async () => {
    const requested = new ContextContainer();
    contextStorage.run(requested, () => {
      expect(requestPrivateApplyApproval(scope, "first")).toBe("user-approval");
    });
    const execution = await deserializeContext(serializeContext(requested));
    // Eve executes the approved request; model-facing tool failures are caught by its tool loop.
    expect(() =>
      contextStorage.run(execution, () => {
        recordApprovedPrivateApply(scope, "first");
        throw new Error("implementation has no Server Action");
      }),
    ).toThrow("no Server Action");
    const resumed = await deserializeContext(serializeContext(execution));
    contextStorage.run(resumed, () => {
      expect(requestPrivateApplyApproval(scope, "repair")).toBe("approved");
      expect(() => {
        recordApprovedPrivateApply(scope, "repair");
      }).not.toThrow();
      expect(() => {
        recordApprovedPrivateApply(scope, "repair");
      }).not.toThrow();
    });
  });
  it("does not turn an unanswered or denied request into a grant", async () => {
    const requested = new ContextContainer();
    contextStorage.run(requested, () => {
      expect(requestPrivateApplyApproval(scope, "denied")).toBe("user-approval");
    });
    // A denied approval does not execute the authored tool.
    const resumed = await deserializeContext(serializeContext(requested));
    contextStorage.run(resumed, () => {
      expect(requestPrivateApplyApproval(scope, "next")).toBe("user-approval");
    });
  });
  it.each(["appId", "appSpecDigest", "proposalDigest", "sessionId", "workspaceId"] as const)(
    "requires new approval when %s changes",
    (key) => {
      contextStorage.run(new ContextContainer(), () => {
        requestPrivateApplyApproval(scope, "approved");
        recordApprovedPrivateApply(scope, "approved");
        expect(requestPrivateApplyApproval({ ...scope, [key]: "changed" }, "new")).toBe(
          "user-approval",
        );
      });
    },
  );
  it("rejects stale pending approval before recording authorization", () => {
    contextStorage.run(new ContextContainer(), () => {
      requestPrivateApplyApproval(scope, "pending");
      const changed = { ...scope, proposalDigest: "changed" };
      expect(() => {
        recordApprovedPrivateApply(changed, "pending");
      }).toThrow("no longer matches");
      expect(() => requestPrivateApplyApproval(changed, "pending")).toThrow("different proposal");
      expect(requestPrivateApplyApproval(changed, "fresh")).toBe("user-approval");
      expect(() => {
        recordApprovedPrivateApply(scope, "unknown");
      }).toThrow("no longer matches");
    });
  });
});
