// oxlint-disable-next-line sonarjs/no-wildcard-import -- Spy on only the authenticated terminal log-store boundary.
import * as logStoreBoundary from "./validation-log-store-for-session";
import { ValidationLogWriter } from "../repository/validation-log";
import type {
  ValidationLogStore,
  ValidationLogReference,
  ValidationLogKey,
} from "../repository/validation-log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import getValidationLog, { validationLogInputSchema } from "../../agent/tools/get_validation_log";
import { appBuilderWorkflowState, APP_BUILDER_WORKFLOW_VERSION } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import type { CandidateValidationAttempt } from "./draft-reconciliation-state";

// SAFETY: The attempt array is typed to the exact retained session evidence contract.
// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Hoisted Vitest state needs a type-only seed for the real state interface.
const candidateState = vi.hoisted(() => ({
  attempts: [] as CandidateValidationAttempt[],
  get: vi.fn(() => candidateState.attempts),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Test injects the retained-state handle without an active Eve runtime.
vi.mock("@/lib/agent/draft-reconciliation-state", () => ({
  candidateValidationAttemptHistory: { get: candidateState.get },
}));

const attemptDigest = "a".repeat(64);
const receiptDigest = "b".repeat(64);
const commands = [
  {
    command: "mise run --no-deps --skip-tools app:check example" as const,
    exitCode: 1,
    inputTreeDigest: "c".repeat(64),
    logs: {
      stderr: {
        bytes: 1,
        channel: "stderr" as const,
        chunkCount: 1,
        digest: "d".repeat(64),
        logId: "123e4567-e89b-42d3-a456-426614174001",
      },
      stdout: {
        bytes: 0,
        channel: "stdout" as const,
        chunkCount: 0,
        digest: "e".repeat(64),
        logId: "123e4567-e89b-42d3-a456-426614174002",
      },
    },
    name: "check-build" as const,
    stderrDigest: "d".repeat(64),
    stdoutDigest: "e".repeat(64),
    validationRoot: "/workspace/repository",
  },
];
const receipt = { attemptDigest, commands, digest: receiptDigest, status: "passed" as const };
const workflow = (phase: AppBuilderWorkflowState["phase"]) => {
  if (phase === "validation_failed") {
    // SAFETY: Discovery consumes only phase and the retained receipt fields; unused workspace fields are absent from this narrow fixture.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Exact consumed failure receipt fields are supplied to this phase-only fixture.
    return {
      phase,
      validationFailure: { ...receipt, status: "failed" },
      version: APP_BUILDER_WORKFLOW_VERSION,
    } as unknown as AppBuilderWorkflowState;
  }
  const laterPhases = [
    "validated",
    "reviewed",
    "publication_pending",
    "published_local",
    "published_branch_worktree",
    "published_fresh_bootstrap",
  ];
  if (laterPhases.includes(phase)) {
    // SAFETY: Discovery consumes only phase and retained validationReceipt; unused publication/workspace fields are absent.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exact consumed successful receipt fields are supplied.
    return {
      phase,
      validationReceipt: receipt,
      version: APP_BUILDER_WORKFLOW_VERSION,
    } as AppBuilderWorkflowState;
  }
  // SAFETY: These phases have no retained completed validation receipt, and discovery inspects no other fields.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Phase-only absence fixture.
  return { phase, version: APP_BUILDER_WORKFLOW_VERSION } as AppBuilderWorkflowState;
};
const auth = (workspace = "workspace-a", user = "user-a") => ({
  attributes: {
    "mcp:audience": "https://builder.example.test/mcp",
    "mcp:scopes": ["eve:start"],
    "mcp:workspace-id": workspace,
  },
  authenticator: "mcp-oauth-jwks" as const,
  issuer: "https://builder.example.test/api/auth",
  principalId: user,
  principalType: "user" as const,
  subject: user,
});
const context = (current = auth(), initiator = current) => ({
  abortSignal: new AbortController().signal,
  callId: "validation-reference-discovery",
  getSandbox: vi.fn().mockRejectedValue(new Error("compute unavailable")),
  getSkill: vi.fn(),
  getToken: vi.fn(),
  requireAuth: (): never => {
    throw new Error("Unexpected auth redirect");
  },
  session: { auth: { current, initiator }, id: "session-a", turn: { id: "turn", sequence: 0 } },
  toolName: "get_validation_log",
});

const keyFor = (key: ValidationLogKey) =>
  JSON.stringify([key.sessionId, key.attemptDigest, key.command, key.channel, key.logId]);

beforeEach(() => {
  candidateState.attempts = [];
  candidateState.get.mockClear();
  vi.stubEnv("APP_BUILDER_EXECUTION_MODE", "hosted");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("owned current validation attempt discovery", () => {
  it.each([
    "validation_failed",
    "validated",
    "reviewed",
    "publication_pending",
    "published_local",
    "published_branch_worktree",
    "published_fresh_bootstrap",
  ] as const)(
    "returns complete retained inputs during %s without running compute",
    async (phase) => {
      const state = workflow(phase);
      const original = JSON.stringify(state);
      const getState = vi.spyOn(appBuilderWorkflowState, "get").mockReturnValue(state);
      const ctx = context();
      const result = await getValidationLog.execute({ operation: "validation-attempts" }, ctx);
      expect(result).toMatchObject({
        attempts: [
          {
            attemptDigest,
            commands: [
              {
                logs: {
                  stderr: {
                    readInput: {
                      attemptDigest,
                      channel: "stderr",
                      command: "check-build",
                      digest: "d".repeat(64),
                      logId: "123e4567-e89b-42d3-a456-426614174001",
                    },
                  },
                  stdout: {
                    readInput: {
                      attemptDigest,
                      channel: "stdout",
                      command: "check-build",
                      digest: "e".repeat(64),
                      logId: "123e4567-e89b-42d3-a456-426614174002",
                    },
                  },
                },
              },
            ],
            status: phase === "validation_failed" ? "failed" : "passed",
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain(receiptDigest);
      expect(JSON.stringify(state)).toBe(original);
      expect(getState).toHaveBeenCalledOnce();
      expect(ctx.getSandbox).not.toHaveBeenCalled();
    },
  );

  it.each(["empty", "prepared", "applied", "validation_pending"] as const)(
    "reports honest absence during %s",
    async (phase) => {
      vi.spyOn(appBuilderWorkflowState, "get").mockReturnValue(workflow(phase));
      expect(
        await getValidationLog.execute({ operation: "validation-attempts" }, context()),
      ).toEqual({ attempts: [] });
    },
  );

  it.each(["owner", "workspace"] as const)(
    "rejects a changed %s before reading workflow state",
    async (field) => {
      const getState = vi
        .spyOn(appBuilderWorkflowState, "get")
        .mockReturnValue(workflow("validation_failed"));
      const ctx = context(
        field === "owner" ? auth("workspace-a", "other-user") : auth("other-workspace"),
        auth(),
      );
      await expect(
        getValidationLog.execute({ operation: "validation-attempts" }, ctx),
      ).rejects.toThrow("authority");
      expect(getState).not.toHaveBeenCalled();
      expect(candidateState.get).not.toHaveBeenCalled();
    },
  );

  it("retains the strict page tuple and existing dependency discovery inputs", () => {
    expect(validationLogInputSchema.parse({ operation: "validation-attempts" })).toEqual({
      operation: "validation-attempts",
    });
    expect(validationLogInputSchema.parse({ operation: "dependency-attempts" })).toEqual({
      operation: "dependency-attempts",
    });
    expect(
      validationLogInputSchema.safeParse({
        logId: commands[0]?.logs.stderr.logId,
        operation: "validation-attempts",
      }).success,
    ).toBe(false);
    expect(
      validationLogInputSchema.safeParse({
        attemptDigest,
        digest: "d".repeat(64),
        logId: commands[0]?.logs.stderr.logId,
      }).success,
    ).toBe(false);
  });
});

it("discovers retained candidate failure references after repair and reads every authenticated page", async () => {
  const candidateAttemptDigest = "f".repeat(64);
  const manifests = new Map<string, ValidationLogReference>();
  const chunks = new Map<string, { content: string; digest: string }>();
  const store: ValidationLogStore = {
    async getChunk(key, index) {
      return await Promise.resolve(chunks.get(`${keyFor(key)}:${index}`));
    },
    async getReference(key) {
      return await Promise.resolve(manifests.get(keyFor(key)));
    },
    async publish(key, reference) {
      await Promise.resolve(manifests.set(keyFor(key), reference));
    },
    async putChunk(key, index, content, digest) {
      await Promise.resolve(chunks.set(`${keyFor(key)}:${index}`, { content, digest }));
    },
    async removeStaged(key) {
      await Promise.resolve(manifests.delete(keyFor(key)));
    },
  };
  vi.spyOn(logStoreBoundary, "validationLogStoreForSession").mockResolvedValue(store);
  const writer = new ValidationLogWriter(store, {
    attemptDigest: candidateAttemptDigest,
    channel: "stderr",
    command: "check-build",
    sessionId: "session-a",
  });
  const original = `${"assertion failed\n".repeat(6000)}Bearer should-be-redacted`;
  await writer.append(original);
  const { reference } = await writer.finishCapture("complete");
  vi.spyOn(appBuilderWorkflowState, "get").mockReturnValue(workflow("empty"));
  candidateState.attempts.push({
    appId: "spend-review",
    attemptDigest: candidateAttemptDigest,
    baseSha: "base",
    callId: "call-1",
    category: "check-build",
    command: "mise run --no-deps --skip-tools app:check spend-review",
    completion: "complete",
    durability: "available",
    exitCode: 2,
    githubSourceDigest: "source",
    headSha: "head",
    logs: { stderr: reference },
    originalReviewDigest: "review",
    pullRequestNumber: 7,
    repositoryId: "repo",
    resolvedTree: "tree",
  });
  const discovery = await getValidationLog.execute({ operation: "validation-attempts" }, context());
  expect(discovery).toMatchObject({
    attempts: [
      {
        commands: [
          {
            logs: {
              stderr: {
                readInput: {
                  attemptDigest: candidateAttemptDigest,
                  channel: "stderr",
                  command: "check-build",
                  digest: reference?.digest,
                  logId: reference?.logId,
                },
              },
            },
          },
        ],
        identity: { appId: "spend-review", headSha: "head" },
        status: "failed",
      },
    ],
  });
  // A simulated ordinary repair/reset does not mutate this separately retained history.
  // SAFETY: Discovery was just asserted to contain the candidate failure's complete stderr reference.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Narrow the tool's test context result to the asserted discovery shape.
  const retained = (await getValidationLog.execute(
    { operation: "validation-attempts" },
    context(),
  )) as {
    attempts: {
      commands: {
        logs: {
          stderr: {
            readInput: {
              attemptDigest: string;
              channel: "stderr";
              command: "check-build";
              digest: string;
              logId: string;
            };
          };
        };
      }[];
    }[];
  };
  const recovered = retained.attempts[0]?.commands[0]?.logs.stderr.readInput;
  if (recovered === undefined) {
    throw new Error("Candidate failure log reference was not retained.");
  }
  let cursor: string | undefined;
  let assembled = "";
  do {
    const pageInput = cursor === undefined ? recovered : { ...recovered, cursor };
    // SAFETY: The page call uses the real strict input schema and session-owned store fixture.
    // oxlint-disable-next-line eslint/no-await-in-loop, typescript/no-unsafe-type-assertion -- Page reads are cursor chained and the tool result is narrowed to this fixture response.
    const page = (await getValidationLog.execute(pageInput, context())) as {
      complete: boolean;
      content: string;
      nextCursor?: string;
    };
    assembled += page.content;
    cursor = page.nextCursor;
    if (page.complete) {
      break;
    }
  } while (cursor !== undefined);
  expect(createHash("sha256").update(assembled).digest("hex")).toBe(reference?.digest);
  expect(assembled).not.toContain("should-be-redacted");
  expect(context().getSandbox).not.toHaveBeenCalled();
});

it("keeps command success separate from unavailable log durability in historical discovery", async () => {
  vi.spyOn(appBuilderWorkflowState, "get").mockReturnValue(workflow("empty"));
  candidateState.attempts.push({
    appId: "spend-review",
    attemptDigest: "c".repeat(64),
    baseSha: "base",
    callId: "call-success",
    category: "check-build",
    command: "mise run --no-deps --skip-tools app:check spend-review",
    completion: "complete",
    durability: "unavailable",
    exitCode: 0,
    githubSourceDigest: "source",
    headSha: "head",
    logs: {},
    originalReviewDigest: "review",
    pullRequestNumber: 7,
    repositoryId: "repo",
    resolvedTree: "tree",
  });
  await expect(
    getValidationLog.execute({ operation: "validation-attempts" }, context()),
  ).resolves.toMatchObject({
    attempts: [
      {
        commands: [{ completion: "complete", durability: "unavailable", exitCode: 0 }],
        status: "passed",
      },
    ],
  });
});

it("rejects a mixed attempt/log tuple rather than substituting the current discovered attempt", async () => {
  const manifests = new Map<string, ValidationLogReference>();
  const chunks = new Map<string, { content: string; digest: string }>();
  const store: ValidationLogStore = {
    async getChunk(key, index) {
      return await Promise.resolve(chunks.get(`${keyFor(key)}:${index}`));
    },
    async getReference(key) {
      return await Promise.resolve(manifests.get(keyFor(key)));
    },
    async publish(key, reference) {
      await Promise.resolve(manifests.set(keyFor(key), reference));
    },
    async putChunk(key, index, content, digest) {
      await Promise.resolve(chunks.set(`${keyFor(key)}:${index}`, { content, digest }));
    },
    async removeStaged(key) {
      await Promise.resolve(manifests.delete(keyFor(key)));
    },
  };
  vi.spyOn(logStoreBoundary, "validationLogStoreForSession").mockResolvedValue(store);
  const writer = new ValidationLogWriter(store, {
    attemptDigest,
    channel: "stderr",
    command: "check-build",
    sessionId: "session-a",
  });
  await writer.append("Current validation error\n");
  const { reference } = await writer.finish("complete");
  const input = {
    attemptDigest,
    channel: "stderr" as const,
    command: "check-build" as const,
    digest: reference.digest,
    logId: reference.logId,
  };
  await expect(
    getValidationLog.execute({ ...input, attemptDigest: "9".repeat(64) }, context()),
  ).rejects.toThrow("unavailable for this session or digest");
  await expect(
    getValidationLog.execute({ ...input, digest: receiptDigest }, context()),
  ).rejects.toThrow("unavailable for this session or digest");
  expect(await getValidationLog.execute(input, context())).toMatchObject({
    complete: true,
    content: "Current validation error\n",
    digest: reference.digest,
  });
});
