/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Exercises the installed private native observer using synthetic authority and collector ports. */
/* oxlint-disable eslint/require-await -- Synthetic asynchronous ports perform no live I/O. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const require = createRequire(import.meta.url);
const sdk = path.dirname(require.resolve("eve/package.json"));
const { observeTerminalSession } = await import(
  pathToFileURL(path.join(sdk, "dist/src/execution/session/terminal-recovery.js")).href
);
let sequence = 0;
const fixture = () => {
  sequence += 1;
  const descriptor = {
    version: 1,
    operationId: `facts-${sequence}`,
    sourcePublicSessionId: "public-source",
    sourceOwnerRunId: "physical-source",
    sourceAdapterGeneration: 1,
    logicalSessionId: "logical-source",
    originalAuthoritySessionId: "public-source",
    parentCancellationRevision: 0,
  };
  const binding = {
    ownerRunId: descriptor.sourceOwnerRunId,
    logicalSessionId: descriptor.logicalSessionId,
  };
  const payload = {
    binding,
    candidates: [],
    nativeEvents: [],
    events: [],
    issues: [],
    frontier: [],
    run: { status: "failed" },
  };
  const state = { authorized: 0, denied: false, effects: 0, receipt: null, reports: [] };
  const effect = () => {
    state.effects += 1;
    throw new Error("Unexpected effect");
  };
  const ports = {
    authorize: async () => {
      state.authorized += 1;
      if (state.denied) {
        throw new Error("denied");
      }
    },
    readReceipt: async () => state.receipt,
    authorizeActivation: effect,
    commitReceipt: effect,
  };
  const input = {
    auth: { authenticator: "test", principalType: "user", principalId: "owner" },
    descriptor,
    ports,
  };
  const deps = {
    collect: async ({ binding: selected, authorizeOwner }) => {
      await authorizeOwner(selected);
      return { kind: "candidate", candidate: payload };
    },
    readCandidate: (candidate) => candidate,
    recordObservation: (record) => {
      state.reports.push({ record, authorized: state.authorized });
      return true;
    },
    now: () => 0,
    start: effect,
    resumeHook: effect,
    reconcile: effect,
    readEntry: effect,
    getHook: effect,
  };
  return { input, deps, payload, state };
};

test("trusted candidate facts run within exact-owner authorization, revalidate before emission and deduplicate only completed observation", async () => {
  const f = fixture();
  const facts = {
    flags: { explicitlyAbsent: true, unavailable: null },
    counts: { candidates: 0 },
    hashes: { scopeHash: "a".repeat(64) },
  };
  let calls = 0;
  let authorizedAtProjection = 0;
  const before = JSON.stringify(f.payload);
  f.input.ports.observeCandidateFacts = async (input) => {
    calls += 1;
    authorizedAtProjection = f.state.authorized;
    assert.equal(input.auth, f.input.auth);
    assert.equal(input.descriptor, f.input.descriptor);
    assert.equal(input.payload, f.payload);
    assert.deepEqual(input.binding, f.payload.binding);
    return facts;
  };
  await observeTerminalSession(f.input, f.deps);
  await observeTerminalSession(f.input, f.deps);
  assert.equal(calls, 1);
  assert.equal(f.state.reports.length, 1);
  assert.equal(f.state.reports[0].record.candidateFacts, facts);
  assert.ok(f.state.reports[0].authorized > authorizedAtProjection);
  assert.equal(JSON.stringify(f.payload), before);
  assert.equal(f.state.effects, 0);
});
test("a trusted projection failure is advisory and cannot skip final authority checks", async () => {
  const f = fixture();
  f.input.ports.observeCandidateFacts = async () => {
    throw new Error("projection unavailable");
  };
  await observeTerminalSession(f.input, f.deps);
  assert.equal(f.state.reports.length, 1);
  assert.equal(f.state.reports[0].record.candidateFacts, undefined);
  assert.equal(f.state.effects, 0);
});
test("authority revoked by the projection rejects observation before facts can be emitted", async () => {
  const f = fixture();
  f.input.ports.observeCandidateFacts = async () => {
    f.state.denied = true;
    return { flags: {}, counts: {}, hashes: {} };
  };
  await assert.rejects(observeTerminalSession(f.input, f.deps), /denied/u);
  assert.equal(f.state.reports.length, 0);
  assert.equal(f.state.effects, 0);
});
test("receipt changed by the projection rejects observation before facts can be emitted", async () => {
  const f = fixture();
  f.input.ports.observeCandidateFacts = async () => {
    f.state.receipt = { ...f.input.descriptor, ownerRunId: "different-owner" };
    return { flags: {}, counts: {}, hashes: {} };
  };
  await assert.rejects(observeTerminalSession(f.input, f.deps), /receipt changed/u);
  assert.equal(f.state.reports.length, 0);
  assert.equal(f.state.effects, 0);
});
test("a mismatched collected owner never reaches the trusted callback", async () => {
  const f = fixture();
  let calls = 0;
  f.input.ports.observeCandidateFacts = async () => {
    calls += 1;
    return { flags: {}, counts: {}, hashes: {} };
  };
  f.deps.readCandidate = () => ({
    ...f.payload,
    binding: { ...f.payload.binding, ownerRunId: "foreign-owner" },
  });
  await observeTerminalSession(f.input, f.deps);
  assert.equal(calls, 0);
  assert.equal(f.state.reports.length, 0);
  assert.equal(f.state.effects, 0);
});
