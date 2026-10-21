/* oxlint-disable typescript/only-throw-error, typescript/prefer-promise-reject-errors -- Negative fixtures intentionally throw hostile non-Error values; compiled error constructors load through installed private JavaScript. */
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Exercises installed native SDK modules with synthetic authority and hook ports. */
/* oxlint-disable eslint/require-await -- Synthetic asynchronous ports perform no live I/O. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { z } from "zod";

const require = createRequire(import.meta.url);
const sdk = pathToFileURL(`${path.dirname(require.resolve("eve/package.json"))}/dist/src/`).href;
const { activateTerminalSession } = await import(`${sdk}execution/session/terminal-recovery.js`);
const { WorkflowWorldError, RunExpiredError, HookNotFoundError, RuntimeDecryptionError } =
  await import(`${sdk}compiled/@workflow/errors/index.js`);
const canary = "NEVER_LOG_private_token_auth_ID_URL_state";
const prefix = "[eve:terminal-recovery-activation] ";
const fixture = () => {
  const descriptor = {
    version: 1,
    operationId: `${canary}-operation`,
    sourcePublicSessionId: `${canary}-public`,
    sourceOwnerRunId: `${canary}-source`,
    sourceAdapterGeneration: 1,
    logicalSessionId: `${canary}-logical`,
    originalAuthoritySessionId: `${canary}-authority`,
    parentCancellationRevision: 0,
  };
  const receipt = {
    ...descriptor,
    ownerRunId: `${canary}-child`,
    provenance: {
      kind: "committed-turn-output",
      sourceStepId: `${canary}-step`,
      sourceEventId: `${canary}-event`,
      sourceSlot: 1,
      checkpointVersion: 1,
    },
  };
  const state = { authorizations: 0, resumes: 0 };
  const ports = {
    async authorizeActivation() {
      state.authorizations += 1;
    },
    async readReceipt() {
      return receipt;
    },
  };
  const deps = {
    async getHook() {
      return { runId: receipt.ownerRunId, metadata: Promise.resolve({ recoveryBinding: receipt }) };
    },
    async resumeHook() {
      state.resumes += 1;
    },
    isHookNotFound: HookNotFoundError.is,
  };
  const input = {
    auth: { authenticator: canary, principalType: "user", principalId: canary },
    descriptor,
    ports,
  };
  return { input, deps, receipt, state };
};
const captureFailure = async (f, original, expectedStage) => {
  const logged = [];
  const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    logged.push(args);
  });
  try {
    await assert.rejects(
      activateTerminalSession(f.input, f.deps),
      original === undefined ? undefined : (error) => error === original,
    );
  } finally {
    consoleSpy.mockRestore();
  }
  assert.equal(logged.length, 1);
  assert.equal(logged[0].length, 1);
  const line = z.string().parse(logged[0][0]);
  assert.equal(line.startsWith(prefix), true);
  assert.equal(line.includes(canary), false);
  const summary = JSON.parse(line.slice(prefix.length));
  assert.equal(summary.event, "eve.terminal_recovery_activation_failed");
  assert.equal(summary.stage, expectedStage);
  assert.equal(
    Object.keys(summary).every((key) =>
      ["event", "stage", "errorClass", "code", "status"].includes(key),
    ),
    true,
  );
  return summary;
};

test("receipt read errors retain identity and log only closed compiled error facts", async () => {
  const f = fixture();
  const failure = new WorkflowWorldError(canary, {
    status: 503,
    code: "TRANSPORT",
    url: canary,
    cause: new RunExpiredError(canary, canary),
  });
  f.input.ports.readReceipt = async () => {
    throw failure;
  };
  assert.deepEqual(await captureFailure(f, failure, "receipt_read"), {
    event: "eve.terminal_recovery_activation_failed",
    stage: "receipt_read",
    errorClass: "WorkflowWorldError",
    code: "TRANSPORT",
    status: 503,
  });
  assert.equal(f.state.resumes, 0);
});
test("invalid receipts preserve the existing rejection and fixed validation stage", async () => {
  const f = fixture();
  f.input.ports.readReceipt = async () => null;
  const summary = await captureFailure(f, undefined, "receipt_validate");
  assert.equal(summary.errorClass, "other");
  assert.equal(f.state.resumes, 0);
});
test("an actual expired hook lookup remains a failure and is never treated as a missing hook", async () => {
  const f = fixture();
  const failure = new RunExpiredError(canary, canary);
  f.deps.getHook = async () => {
    throw failure;
  };
  assert.deepEqual(await captureFailure(f, failure, "hook_lookup"), {
    event: "eve.terminal_recovery_activation_failed",
    stage: "hook_lookup",
    errorClass: "RunExpiredError",
    code: "run-expired",
    status: 410,
  });
  assert.equal(f.state.resumes, 0);
});
test("metadata decryption errors never expose their message or private context", async () => {
  const f = fixture();
  const failure = new RuntimeDecryptionError(canary, { context: { private: canary } });
  f.deps.getHook = async () => ({
    runId: f.receipt.ownerRunId,
    get metadata() {
      return Promise.reject(failure);
    },
  });
  assert.deepEqual(await captureFailure(f, failure, "hook_metadata"), {
    event: "eve.terminal_recovery_activation_failed",
    stage: "hook_metadata",
    errorClass: "RuntimeDecryptionError",
  });
  assert.equal(f.state.resumes, 0);
});
test("a changed hook binding retains the existing receipt comparison rejection", async () => {
  const f = fixture();
  f.deps.getHook = async () => ({
    runId: `${canary}-other`,
    metadata: Promise.resolve({ recoveryBinding: f.receipt }),
  });
  await captureFailure(f, undefined, "hook_validate");
  assert.equal(f.state.resumes, 0);
});
test("revocation before resume retains the original error and performs no resume", async () => {
  const f = fixture();
  const failure = new Error(canary);
  f.input.ports.authorizeActivation = async () => {
    f.state.authorizations += 1;
    if (f.state.authorizations === 2) {
      throw failure;
    }
  };
  await captureFailure(f, failure, "reauthorize");
  assert.equal(f.state.resumes, 0);
});
test("resume failure retains the original compiled error and has its own stage", async () => {
  const f = fixture();
  const failure = new WorkflowWorldError(canary, { code: "TIMEOUT", status: 504, url: canary });
  f.deps.resumeHook = async () => {
    f.state.resumes += 1;
    throw failure;
  };
  const summary = await captureFailure(f, failure, "resume");
  assert.equal(summary.code, "TIMEOUT");
  assert.equal(summary.status, 504);
  assert.equal(f.state.resumes, 1);
});
test("unknown names, arbitrary codes, invalid status and deep causes cannot leak", async () => {
  const f = fixture();
  const hidden = new WorkflowWorldError(canary, { code: "TIMEOUT", status: 504 });
  const failure = {
    name: canary,
    code: canary,
    status: 600,
    message: canary,
    cause: { cause: { cause: hidden } },
  };
  f.input.ports.readReceipt = async () => {
    throw failure;
  };
  assert.deepEqual(await captureFailure(f, failure, "receipt_read"), {
    event: "eve.terminal_recovery_activation_failed",
    stage: "receipt_read",
    errorClass: "other",
  });
});
test("hostile error getters are not called and cause cycles terminate", async () => {
  const f = fixture();
  const getter = vi.fn(() => {
    throw new Error(canary);
  });
  const failure = Object.defineProperties(
    {},
    Object.fromEntries(
      ["name", "code", "status", "message", "stack"].map((key) => [key, { get: getter }]),
    ),
  );
  failure.cause = failure;
  f.input.ports.readReceipt = async () => {
    throw failure;
  };
  const summary = await captureFailure(f, failure, "receipt_read");
  assert.equal(summary.errorClass, "other");
  assert.equal(getter.mock.calls.length, 0);
});
test("a hostile error proxy still produces a minimal stage without replacing the exception", async () => {
  const f = fixture();
  const failure = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error(canary);
      },
    },
  );
  f.input.ports.readReceipt = async () => {
    throw failure;
  };
  const summary = await captureFailure(f, failure, "receipt_read");
  assert.equal(summary.errorClass, "other");
});
test("a failed logging sink cannot replace the original activation failure", async () => {
  const f = fixture();
  const failure = new Error(canary);
  f.input.ports.readReceipt = async () => {
    throw failure;
  };
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {
    throw new Error(canary);
  });
  try {
    await assert.rejects(activateTerminalSession(f.input, f.deps), (error) => error === failure);
  } finally {
    consoleSpy.mockRestore();
  }
});
test("actual missing hooks and already-consumed resume hooks retain successful no-op semantics without failure logs", async () => {
  const f = fixture();
  const observed = [];
  const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    observed.push(args);
  });
  try {
    f.deps.getHook = async () => {
      throw new HookNotFoundError(canary);
    };
    assert.deepEqual(await activateTerminalSession(f.input, f.deps), {
      kind: "accepted",
      recoveryBinding: f.receipt,
    });
    assert.equal(f.state.resumes, 0);
    f.deps.getHook = async () => ({
      runId: f.receipt.ownerRunId,
      metadata: Promise.resolve({ recoveryBinding: f.receipt }),
    });
    f.deps.resumeHook = async () => {
      f.state.resumes += 1;
      throw new HookNotFoundError(canary);
    };
    assert.deepEqual(await activateTerminalSession(f.input, f.deps), {
      kind: "accepted",
      recoveryBinding: f.receipt,
    });
    assert.equal(f.state.resumes, 1);
    assert.equal(observed.length, 0);
  } finally {
    consoleSpy.mockRestore();
  }
});
