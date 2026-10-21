/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Installed private Eve JavaScript APIs are exercised with synthetic native ports. */
/* oxlint-disable eslint/require-await -- Synthetic asynchronous ports perform no live I/O. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import {
  createHostedEveSessionService,
  HostedSubmissionUnknownError,
  HostedRejectedOperationError,
} from "../lib/eve/hosted-service.ts";
import { InMemoryHostedEveStore } from "../lib/eve/hosted-store.ts";
import { createNativeRecoveryBinding } from "../lib/eve/native-recovery-binding.ts";
import { createSameOriginEveTransport } from "../lib/eve/same-origin-http.ts";
import { hostedEveOperationScopes } from "../lib/eve/hosted-auth.ts";

const require = createRequire(import.meta.url);
const sdk = path.dirname(require.resolve("eve/package.json"));
const { recoverTerminalSession, activateTerminalSession } = await import(
  pathToFileURL(path.join(sdk, "dist/src/execution/session/terminal-recovery.js")).href
);

test("unknown CID adopts a terminal receipt without replay, GET exposes failure and ordinary resume reconciles the failed child", async () => {
  const principal = {
    audience: "https://builder.example.test/mcp",
    issuer: "https://builder.example.test/api/auth",
    ownerUserId: "owner",
    workspaceId: "tenant",
    scopes: Object.values(hostedEveOperationScopes),
  };
  const auth = {
    authenticator: "mcp-oauth-jwks",
    issuer: principal.issuer,
    principalId: principal.ownerUserId,
    principalType: "user",
    subject: principal.ownerUserId,
    attributes: {
      "mcp:audience": principal.audience,
      "mcp:scopes": principal.scopes,
      "mcp:workspace-id": principal.workspaceId,
    },
  };
  const store = new InMemoryHostedEveStore();
  const failed = { events: [], status: "failed" };
  const ports = createNativeRecoveryBinding({
    store,
    assertOwner: async (source) => {
      assert.equal(source.principal.ownerUserId, principal.ownerUserId);
    },
  });
  const frontier = Object.freeze({ kind: "fixture-candidate" });
  const collectedOwners = [];
  const reconciled = [];
  let ownerStarts = 0;
  let activations = 0;
  const deps = {
    collect: async ({ binding, authorizeOwner }) => {
      await authorizeOwner(binding);
      collectedOwners.push(binding);
      return { kind: "candidate", candidate: frontier };
    },
    reconcile: async (candidate) => {
      reconciled.push(candidate);
      return { kind: "uncertain", reason: "fixture-stops-at-reconciler" };
    },
    start: async () => {
      ownerStarts += 1;
      throw new Error("No new native owner is authorized by this fixture.");
    },
    resumeHook: async () => {
      activations += 1;
      throw new Error("The retained terminal owner's hook was consumed.");
    },
    getHook: async () => {
      throw new Error("hook-missing");
    },
    isHookNotFound: (error) => error.message === "hook-missing",
  };
  let lostFirstResponse = false;
  let oldReceipt;
  let receiptCommitFailure;
  const http = createSameOriginEveTransport({
    config: { baseUrl: "https://builder.example.test" },
    workloadIdentity: { token: async () => "synthetic-workload-token" },
    fetchImplementation: async (url, options) => {
      assert.equal(url, "https://builder.example.test/eve/v1/session");
      const payload = JSON.parse(options.body);
      const descriptor = payload.recovery;
      assert.ok(descriptor !== undefined);
      if (!lostFirstResponse) {
        lostFirstResponse = true;
        oldReceipt = {
          ...descriptor,
          ownerRunId: "physical-terminal-child",
          provenance: {
            kind: "completed-terminal-turn-input",
            sourceStepId: "retained-step",
            sourceEventId: "retained-event",
            sourceSlot: 1,
            checkpointVersion: 1,
          },
        };
        try {
          await ports.commitReceipt({ auth, descriptor, recoveryBinding: oldReceipt });
        } catch (error) {
          receiptCommitFailure = error;
          throw error;
        }
        throw new Error("Lost old native receipt response.");
      }
      const result =
        payload.recoveryPhase === "activate"
          ? await activateTerminalSession({ auth, descriptor, ports }, deps)
          : await recoverTerminalSession({ auth, descriptor, ports }, deps);
      if (result.kind !== "accepted") {
        return Response.json({ ok: false, code: "terminal_recovery_uncertain" }, { status: 409 });
      }
      return Response.json(
        {
          ok: true,
          status: "accepted",
          sessionId: result.recoveryBinding.ownerRunId,
          recoveryBinding: result.recoveryBinding,
        },
        { status: 202 },
      );
    },
  });
  const transport = {
    ...http,
    start: async (request) =>
      request.recovery === undefined
        ? { adapterSessionId: "logical-original", snapshot: failed }
        : await http.start(request),
    get: async ({ adapterSessionId }) => {
      assert.equal(adapterSessionId, "physical-terminal-child");
      return failed;
    },
  };
  const service = () =>
    createHostedEveSessionService({
      principal,
      store,
      transport,
      now: () => 100,
      assertNativeRecoveryOwner: async (source) => {
        assert.equal(source.principal.ownerUserId, principal.ownerUserId);
      },
    });
  const original = await service().start({ clientRequestId: "original", prompt: "Build app" });
  const protection = {
    appId: "fixture-app",
    appSpecDigest: "a".repeat(64),
    proposalDigest: "b".repeat(64),
    sessionId: "logical-original",
    workspaceId: "private-workspace",
  };
  await store.recordPrivateBuildDecision({
    principal,
    sessionId: original.sessionId,
    decision: {
      adapterSessionId: "logical-original",
      decision: "waiting-input",
      scope: protection,
      turnId: "original-turn",
      turnSequence: 4,
      version: 1,
      workflowPhase: "implementation",
    },
  });
  const oldRequest = { clientRequestId: "saved-unknown", resumeSessionId: original.sessionId };
  await assert.rejects(service().start(oldRequest), HostedSubmissionUnknownError);
  const unknown = await store.getStartOperation(principal, oldRequest.clientRequestId);
  assert.equal(receiptCommitFailure, undefined);
  assert.equal(unknown.state, "submission_unknown");
  assert.deepEqual(unknown.nativeRecoveryReceipt, oldReceipt);
  const adopted = await service().start(oldRequest);
  assert.equal(adopted.status, "working");
  const child = await store.getSession(principal, adopted.sessionId);
  assert.equal(child.adapterSessionId, oldReceipt.ownerRunId);
  assert.equal(child.parentSessionId, original.sessionId);
  assert.equal(child.nativeRecoveryBinding.originalAuthoritySessionId, original.sessionId);
  assert.equal(child.nativeRecoveryBinding.logicalSessionId, "logical-original");
  assert.deepEqual(child.privateBuildDecision.scope, protection);
  assert.equal(child.privateBuildDecision.adapterSessionId, oldReceipt.ownerRunId);
  assert.equal(collectedOwners.length, 0);
  assert.equal(reconciled.length, 0);
  assert.equal(ownerStarts, 0);
  assert.equal(activations, 0);
  const terminal = await service().get({ sessionId: adopted.sessionId, cursor: 0, limit: 100 });
  assert.equal(terminal.status, "failed");
  const newRequest = { clientRequestId: "normal-child-resume", resumeSessionId: adopted.sessionId };
  await assert.rejects(service().start(newRequest), HostedRejectedOperationError);
  const next = await store.getStartOperation(principal, newRequest.clientRequestId);
  assert.notEqual(next.operationId, unknown.operationId);
  assert.equal(next.nativeRecovery.sourcePublicSessionId, adopted.sessionId);
  assert.equal(next.nativeRecovery.sourceOwnerRunId, oldReceipt.ownerRunId);
  assert.equal(next.nativeRecovery.logicalSessionId, "logical-original");
  assert.equal(next.nativeRecovery.originalAuthoritySessionId, original.sessionId);
  assert.equal(next.nativeRecoveryReceipt, undefined);
  assert.deepEqual(collectedOwners, [
    { ownerRunId: oldReceipt.ownerRunId, logicalSessionId: "logical-original" },
  ]);
  assert.deepEqual(reconciled, [frontier]);
  const retainedOperation = await store.getStartOperation(principal, oldRequest.clientRequestId);
  const retainedChild = await store.getSession(principal, adopted.sessionId);
  const retainedOriginal = await store.getSession(principal, original.sessionId);
  assert.deepEqual(retainedOperation.nativeRecoveryReceipt, oldReceipt);
  assert.deepEqual(retainedChild.privateBuildDecision.scope, protection);
  assert.deepEqual(retainedOriginal.privateBuildDecision.scope, protection);
  assert.equal(ownerStarts, 0);
  assert.equal(activations, 0);
});
