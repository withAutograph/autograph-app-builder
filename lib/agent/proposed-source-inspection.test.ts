/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-module-mocking, sonarjs/no-internal-api-use, typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- Real Eve state is populated with bounded partial workflow fixtures; no Sandbox or provider is available. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import type { ToolContext } from "eve/tools";
import { appBuilderWorkflowState, sha256 } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { inspectCurrentProposalSource } from "./proposed-source-inspection";
import {
  readPrivateApplyAuthority,
  requestPrivateApplyApproval,
  recordApprovedPrivateApply,
} from "./private-apply-authority";
import {
  EVE_NATIVE_RESULT_PAGE_BYTES,
  EVE_MAX_PAYLOAD_BYTES,
  serializedPayloadBytes,
} from "../eve/payload-envelope";

import inspectExistingApp from "../../agent/tools/inspect_existing_app";

const sandboxPort = vi.hoisted(() => ({ get: vi.fn(), read: vi.fn(), run: vi.fn() }));
vi.mock("./source-bound-sandbox", () => ({ getSourceBoundSandbox: sandboxPort.get }));

const context = {
  abortSignal: new AbortController().signal,
  session: { id: "owner-session" },
} as Pick<ToolContext, "session" | "abortSignal">;
const run = (operation: () => void | Promise<void>) =>
  contextStorage.run(new ContextContainer(), operation);
const fixture = (content = "proposed bytes", extra = true) => {
  const changes = [
    {
      after: { content, digest: sha256(content), mode: "644" },
      path: "apps/example/app/[...view]/page.tsx",
    },
    ...(extra
      ? [{ before: { digest: sha256("before"), mode: "755" }, path: "apps/example/removed.ts" }]
      : []),
  ];
  const contract = {
    appId: "example",
    appSpec: { path: "apps/example/.config/app-spec.md", sha256: "spec" },
    version: 1,
  };
  const unsigned = {
    appSpecDigest: "spec",
    contractDigest: sha256(JSON.stringify(contract)),
    plannedByCallId: "plan-call",
    sourceReceiptDigest: "source",
    target: {
      contract,
      iteration: { changes, digest: sha256(JSON.stringify(changes)) },
      operation: "iterate-existing-app",
    },
    version: 1,
    workspaceDigest: "workspace",
  };
  const state = {
    appSpec: { appId: "example", digest: "spec" },
    phase: "planned",
    proposal: { ...unsigned, digest: sha256(JSON.stringify(unsigned)) },
    sourceReceipt: { digest: "source" },
    workspace: { workspaceDigest: "workspace", workspaceId: "sandbox" },
  } as unknown as Extract<AppBuilderWorkflowState, { phase: "planned" }>;
  appBuilderWorkflowState.update(() => state);
  return state;
};
const input = (state: ReturnType<typeof fixture>, paths: string[] = []) => ({
  appId: "example",
  expectedProposalDigest: state.proposal.digest,
  pathIndex: 0,
  paths,
});
const scope = (state: ReturnType<typeof fixture>, sessionId = context.session.id) => ({
  appId: "example",
  appSpecDigest: "spec",
  proposalDigest: state.proposal.digest,
  sessionId,
  workspaceId: "sandbox",
});

describe("current frozen proposal inspection", () => {
  it("reads exact unapplied bytes and explicit deletion without Sandbox fallback or state changes", () =>
    run(() => {
      const state = fixture();
      const before = JSON.stringify(state);
      expect(inspectCurrentProposalSource(input(state), context)).toMatchObject({
        availablePaths: ["apps/example/app/[...view]/page.tsx", "apps/example/removed.ts"],
        source: "current-proposal",
        status: "UNAPPLIED",
      });
      const result = inspectCurrentProposalSource(
        input(state, ["app/[...view]/page.tsx", "removed.ts", "not-in-plan.ts"]),
        context,
      );
      expect(result.files).toEqual([
        {
          content: "proposed bytes",
          digest: sha256("proposed bytes"),
          mode: "644",
          offsetBytes: 0,
          operation: "upsert",
          path: "apps/example/app/[...view]/page.tsx",
        },
        {
          beforeDigest: sha256("before"),
          mode: "755",
          operation: "delete",
          path: "apps/example/removed.ts",
        },
      ]);
      expect(result.missingPaths).toEqual(["apps/example/not-in-plan.ts"]);
      expect(JSON.stringify(appBuilderWorkflowState.get())).toBe(before);
      expect(readPrivateApplyAuthority()).toEqual({ grant: null, pending: [] });
      expect(() =>
        inspectCurrentProposalSource(
          {
            ...input(state),
            contentPath: "removed.ts",
            expectedDigest: sha256("before"),
            offsetBytes: 1,
          },
          context,
        ),
      ).toThrow();
    }));
  it("allows inspecting the owner's pending plan without granting or retiring approval", () =>
    run(() => {
      const state = fixture();
      requestPrivateApplyApproval(scope(state), "pending-call");
      const before = readPrivateApplyAuthority();
      expect(inspectCurrentProposalSource(input(state), context).status).toBe("UNAPPLIED");
      expect(readPrivateApplyAuthority()).toEqual(before);
    }));
  it.each(["digest", "app", "phase", "file-hash", "iteration-hash", "owner", "approved"])(
    "rejects %s drift",
    (kind) =>
      run(() => {
        const state = fixture();
        const request = input(state);
        if (kind === "digest") {
          request.expectedProposalDigest = "f".repeat(64);
        }
        if (kind === "app") {
          request.appId = "foreign";
        }
        if (kind === "phase") {
          appBuilderWorkflowState.update(
            () => ({ ...state, phase: "applied" }) as AppBuilderWorkflowState,
          );
        }
        if (kind === "file-hash") {
          if (!("iteration" in state.proposal.target)) {
            throw new Error("fixture");
          }
          const change = state.proposal.target.iteration.changes[0];
          if (!change?.after) {
            throw new Error("fixture");
          }
          change.after.content = "drift";
        }
        if (kind === "iteration-hash") {
          if (!("iteration" in state.proposal.target)) {
            throw new Error("fixture");
          }
          state.proposal.target.iteration.digest = "f".repeat(64);
        }
        if (kind === "owner") {
          requestPrivateApplyApproval(scope(state, "foreign-session"), "pending-call");
        }
        if (kind === "approved") {
          requestPrivateApplyApproval(scope(state), "call");
          recordApprovedPrivateApply(scope(state), "call");
        }
        if (kind === "file-hash" || kind === "iteration-hash") {
          if (!("iteration" in state.proposal.target)) {
            throw new Error("fixture");
          }
          if (kind === "file-hash") {
            state.proposal.target.iteration.digest = sha256(
              JSON.stringify(state.proposal.target.iteration.changes),
            );
          }
          const { digest: previousDigest, ...unsigned } = state.proposal;
          expect(previousDigest).toBe(request.expectedProposalDigest);
          state.proposal.digest = sha256(JSON.stringify(unsigned));
          request.expectedProposalDigest = state.proposal.digest;
        }
        expect(() => inspectCurrentProposalSource(request, context)).toThrow();
      }),
  );
  it.each([
    "../secret",
    "apps/foreign/file.ts",
    "/workspace/repository/apps/example/file.ts",
    "app//file.ts",
  ])("rejects unsafe path %s", (path) =>
    run(() => {
      const state = fixture();
      expect(() => inspectCurrentProposalSource(input(state, [path]), context)).toThrow();
    }),
  );
  it("round-trips bounded Unicode pages with exact proposal and file digests", () =>
    run(() => {
      const content = '🙂é"\\\n'.repeat(EVE_NATIVE_RESULT_PAGE_BYTES / 4);
      const state = fixture(content, false);
      let offsetBytes = 0;
      let joined = "";
      let pages = 0;
      do {
        const result = inspectCurrentProposalSource(
          {
            ...input(state),
            contentPath: "app/[...view]/page.tsx",
            expectedDigest: sha256(content),
            offsetBytes,
          },
          context,
        );
        expect(
          serializedPayloadBytes({
            data: {
              result: { kind: "tool-result", output: result, toolName: "inspect_existing_app" },
            },
            type: "action.result",
          }),
        ).toBeLessThanOrEqual(EVE_MAX_PAYLOAD_BYTES);
        joined += result.files[0]?.content;
        pages += 1;
        if (!result.continuation) {
          break;
        }
        expect(result.continuation.offsetBytes).toBeGreaterThan(offsetBytes);
        offsetBytes = result.continuation.offsetBytes;
      } while (pages < 20);
      expect(pages).toBeGreaterThan(1);
      expect(joined).toBe(content);
      expect(() =>
        inspectCurrentProposalSource(
          {
            ...input(state),
            contentPath: "app/[...view]/page.tsx",
            expectedDigest: "f".repeat(64),
            offsetBytes: 100,
          },
          context,
        ),
      ).toThrow();
    }));
  it("paginates the exact current path inventory without skipping or duplicating paths", () =>
    run(() => {
      const state = fixture();
      if (!("iteration" in state.proposal.target)) {
        throw new Error("fixture");
      }
      const paths = Array.from(
        { length: 500 },
        (_, index) => `apps/example/${"segment/".repeat(400)}file-${index}.ts`,
      );
      state.proposal.target.iteration.changes = paths.map((path) => ({
        after: { content: "", digest: sha256(""), mode: "644" },
        path,
      }));
      state.proposal.target.iteration.digest = sha256(
        JSON.stringify(state.proposal.target.iteration.changes),
      );
      const { digest: previousDigest, ...unsigned } = state.proposal;
      expect(previousDigest).toBeDefined();
      state.proposal.digest = sha256(JSON.stringify(unsigned));
      let pathIndex = 0;
      const observed: string[] = [];
      do {
        const result = inspectCurrentProposalSource({ ...input(state), pathIndex }, context);
        observed.push(...(result.availablePaths ?? []));
        expect(
          serializedPayloadBytes({
            data: {
              result: { kind: "tool-result", output: result, toolName: "inspect_existing_app" },
            },
            type: "action.result",
          }),
        ).toBeLessThanOrEqual(EVE_NATIVE_RESULT_PAGE_BYTES);
        if (result.nextPathIndex === undefined) {
          break;
        }
        expect(result.nextPathIndex).toBeGreaterThan(pathIndex);
        pathIndex = result.nextPathIndex;
      } while (pathIndex < paths.length);
      expect(observed).toEqual(paths.toSorted());
    }));
  it("handles empty proposed files and cancellation before exposing bytes", () =>
    run(() => {
      const state = fixture("", false);
      expect(
        inspectCurrentProposalSource(input(state, ["app/[...view]/page.tsx"]), context).files[0]
          ?.content,
      ).toBe("");
      const abort = new AbortController();
      abort.abort();
      expect(() =>
        inspectCurrentProposalSource(input(state), { ...context, abortSignal: abort.signal }),
      ).toThrow();
    }));
});

it("routes explicit proposal reads through the real tool without acquiring a Sandbox; default still reads applied bytes", async () => {
  await run(async () => {
    const state = fixture();
    sandboxPort.get.mockResolvedValue({ readTextFile: sandboxPort.read, run: sandboxPort.run });
    sandboxPort.read.mockResolvedValue("actually applied bytes");
    sandboxPort.run.mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: "apps/example/app/[...view]/page.tsx\0",
    });
    const resolve = inspectExistingApp.events["step.started"];
    if (resolve === undefined) {
      throw new Error("missing actual tool resolver");
    }
    const tool = await resolve(undefined, {} as never);
    if (tool === null || tool.execute === undefined) {
      throw new Error("missing actual tool");
    }
    if (!(tool.inputSchema instanceof z.ZodType)) {
      throw new Error("Expected actual Zod inspection schema");
    }
    expect(
      tool.inputSchema.safeParse({ appId: "example", source: "current-proposal" }).success,
    ).toBe(true);
    expect(
      tool.inputSchema.safeParse({
        appId: "example",
        expectedProposalDigest: state.proposal.digest,
      }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({
        appId: "example",
        expectedProposalDigest: state.proposal.digest,
        source: "current-proposal",
      }).success,
    ).toBe(true);
    const executeContext = { ...context, callId: "inspection-call" } as ToolContext;
    const proposedInput = {
      appId: "example",
      pathIndex: 0,
      paths: ["app/[...view]/page.tsx"],
      source: "current-proposal" as const,
    };
    const proposed = await tool.execute(proposedInput, executeContext);
    expect(proposed).toMatchObject({
      files: [{ content: "proposed bytes" }],
      proposalDigest: state.proposal.digest,
      status: "UNAPPLIED",
    });
    await expect(
      tool.execute({ ...proposedInput, pathIndex: 1 }, executeContext),
    ).rejects.toThrow();
    expect(sandboxPort.get).not.toHaveBeenCalled();
    const applied = await tool.execute(
      { appId: "example", pathIndex: 0, paths: ["app/[...view]/page.tsx"] },
      executeContext,
    );
    expect(applied).toMatchObject({ files: [{ content: "actually applied bytes" }] });
    expect(applied).not.toHaveProperty("status", "UNAPPLIED");
    expect(sandboxPort.get).toHaveBeenCalledOnce();
  });
});
