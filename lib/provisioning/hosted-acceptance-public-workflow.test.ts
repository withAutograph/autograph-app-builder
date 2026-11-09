/* oxlint-disable anti-slop/no-module-mocking -- Controlled Eve state/definition and provider ports surround the actual tools, recovery, approval capture, steps and service. */
/* oxlint-disable eslint/require-await -- Controlled asynchronous provider ports retain production contracts. */
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import type { MessageStreamEvent } from "eve/client";
import {
  deriveInstalledEveStatus,
  outstandingInstalledEveRequests,
  projectInstalledEveEvent,
} from "../eve/public-events";
import type { ContinuityApprovalToolInput } from "../eve/private-continuity-approval";
import type { OperatorSelection } from "./hosted-operator-contract";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import { z } from "zod";
import planTool from "../../agent/tools/plan-app-hosted-runtime";
import continuityTool from "../../agent/tools/run-app-continuity-tests";
import {
  createPrivateContinuityApprovalCapture,
  continuityApprovalToolInputSchema,
} from "../eve/private-continuity-approval";
import {
  authority,
  context,
  preparedPlan,
  selection,
  setup,
  installManagedAcceptanceSuite,
} from "./hosted-acceptance-recovery.test-fixture";

const hooks = vi.hoisted(() => ({
  state: new Map<string, unknown>(),
  client: vi.fn(),
  projection: vi.fn(),
  repository: vi.fn(),
  sleep: vi.fn(),
  approval: vi.fn<(ctx: ApprovalContext<ContinuityApprovalToolInput>) => Promise<ApprovalStatus>>(),
}));
vi.mock("eve/context", () => ({
  defineState: <T>(key: string, initial: () => T) => ({
    get: () => {
      if (!hooks.state.has(key)) {
        hooks.state.set(key, initial());
      }
      return hooks.state.get(key);
    },
    update: (change: (value: T) => T) => {
      hooks.state.set(key, change(z.custom<T>().parse(hooks.state.get(key))));
    },
  }),
}));
vi.mock("eve/tools", () => ({
  defineTool: <T>(tool: T) => tool,
  defineWorkflowTool: <
    T extends {
      approval: (ctx: ApprovalContext<ContinuityApprovalToolInput>) => Promise<ApprovalStatus>;
    },
  >(
    tool: T,
  ) => {
    hooks.approval.mockImplementation(tool.approval);
    return tool;
  },
}));
vi.mock("workflow", () => ({ sleep: hooks.sleep }));
vi.mock("../agent/prepared-runtime-execution", () => ({
  resolveProtectedRuntimeBindings: hooks.projection,
}));
vi.mock("../agent/deployment-repository-access-runtime", () => ({
  repositoryAccessRuntimeForSession: hooks.repository,
}));
vi.mock("./hosted-operator-client", () => ({ hostedOperatorClientForSession: hooks.client }));

const roots: string[] = [];
afterEach(async () => {
  hooks.state.clear();
  vi.clearAllMocks();
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("uses actual planning and approval workflow tools to recover retained source and run focused managed acceptance", async () => {
  const f = setup();
  const old = await f.operations.plan(
    context,
    { ...selection.runtime, root: "/workspace/stale" },
    "original-intent",
  );
  const priorEvidence = structuredClone(f.rows.get(old.plan.intentId));
  const fixture = await mkdtemp(path.join(tmpdir(), "builder-public-recovery-"));
  roots.push(fixture);
  const source = path.join(fixture, "source");
  const workspace = path.join(fixture, "workspace");
  const stale = path.join(workspace, "stale");
  await mkdir(source);
  await mkdir(stale, { recursive: true });
  await writeFile(path.join(stale, "private.txt"), "retained private edits");
  await writeFile(path.join(stale, "release.txt"), "old-release");
  await writeFile(path.join(source, "release.txt"), preparedPlan.release.id);
  await mkdir(path.join(source, "apps", context.target.appId, ".config"), { recursive: true });
  await writeFile(
    path.join(source, "apps", context.target.appId, ".config/app-spec.md"),
    "Controlled app contract",
  );
  // oxlint-disable-next-line typescript/strict-void-return -- Node supplies execFile's stdout/stderr promisification.
  const exec = promisify(execFile);
  const git = async (...args: string[]) => await exec("git", ["-C", source, ...args]);
  await git("init");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Controlled fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "published release",
  );
  const head = await git("rev-parse", "HEAD");
  const revision = head.stdout.trim();
  const receipt = {
    confirmedByCallId: "existing-repository-approval",
    providerAccessDigest: "a".repeat(64),
    repository: {
      defaultBranch: "main",
      headSha: revision,
      headTree: revision,
      name: "fixture",
      owner: "controlled",
      repositoryId: "123",
    },
    scope: { accountLogin: "controlled", accountType: "Organization", installationId: "456" },
    sessionId: context.target.sessionId,
    version: 1,
  };
  hooks.state.set("autograph-app-builder.repository-access.v1", {
    ...receipt,
    digest: createHash("sha256").update(JSON.stringify(receipt)).digest("hex"),
  });
  // The existing checkout retains private work but has lost its app contract.
  hooks.state.set("autograph-app-builder.workflow.v17", {
    phase: "reviewed",
    githubSource: { digest: "retained-source" },
    sourceReceipt: { sourceKind: "existing-repository" },
    workspace: { workspacePath: "/workspace/stale" },
  });
  hooks.projection.mockResolvedValue({
    plan: { ...preparedPlan, delivery: { gitSha: revision, repoId: "123" } },
  });
  const credential = vi.fn(async () => ({ token: "controlled-installation-token" }));
  hooks.repository.mockResolvedValue({ acquireExistingSourceCredential: credential });
  const policies: unknown[] = [];
  const sandbox: Pick<SandboxSession, "run" | "readTextFile"> & {
    id: string;
    setNetworkPolicy: (policy: SandboxNetworkPolicy) => Promise<void>;
  } = {
    id: selection.runtime.sandboxId,
    setNetworkPolicy: async (policy) => {
      policies.push(policy);
    },
    readTextFile: async ({ path: requested }: { path: string }) => {
      try {
        return await readFile(requested.replaceAll("/workspace", workspace), "utf-8");
      } catch {
        return null;
      }
    },
    run: async ({ command, workingDirectory }) => {
      const cwd = workingDirectory?.replaceAll("/workspace", workspace) ?? workspace;
      if (command.startsWith("mise run app:describe")) {
        try {
          const release = await readFile(path.join(cwd, "release.txt"), "utf-8");
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              app: { id: context.target.appId },
              backend: { release: { id: release } },
            }),
          };
        } catch {
          return { exitCode: 1, stderr: "Missing retained checkout", stdout: "" };
        }
      }
      const localCommand = command
        .replaceAll("/workspace", workspace)
        .replaceAll("https://github.com/controlled/fixture.git", source)
        .replace(/^node /u, `'${process.execPath.replaceAll("'", "'\"'\"'")}' `);
      const result = await exec("/bin/sh", ["-c", localCommand], { cwd });
      return { ...result, exitCode: 0 };
    },
  };
  hooks.client.mockResolvedValue({
    sessionId: context.target.sessionId,
    resolvePreviewTarget: async () => preparedPlan.selection,
    planContinuity: async (
      _selected: OperatorSelection,
      runtime: typeof selection.runtime,
      key: string,
      _signal: AbortSignal,
      recovery?: { predecessorIntentId: string },
    ) => await f.operations.plan(context, runtime, key, recovery),
    readContinuity: async (id: string) => await f.operations.readPlan(context, id),
    continuityApproval: async (request: typeof old.request) =>
      await f.operations.approval(context, request),
    runContinuity: async (request: typeof old.request, callId: string) =>
      await f.operations.execute(context, request, callId),
  });
  const ctx = {
    session: {
      id: context.target.sessionId,
      auth: {},
      ownerRunId: "owner-run",
      ownerAnchorRunId: context.target.sessionId,
    },
    callId: "successor-planning",
    abortSignal: new AbortController().signal,
    getSandbox: async () => sandbox,
  };
  // SAFETY: Every context field consumed by these production tool/step paths is supplied above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Controlled Eve context avoids replacing actual tool implementations.
  const toolCtx = ctx as never;
  const browserSelection = { testName: "@acceptance", workers: 1, retries: 0, maxFailures: 1 };
  const planned = await planTool.execute(
    {
      appId: context.target.appId,
      environment: "preview",
      operation: "continuity",
      recoverContinuityIntentId: old.plan.intentId,
      browserSelection,
    },
    toolCtx,
  );
  const saved = z.object({ plan: z.object({ intentId: z.string() }) }).parse(planned);
  const successor = await f.operations.readPlan(context, saved.plan.intentId);
  const input = continuityApprovalToolInputSchema.parse(successor.request);
  expect(successor.plan.predecessorIntentId).toBe(old.plan.intentId);
  expect(successor.plan.runtime.root).not.toBe("/workspace/stale");
  expect(successor.plan.runtime.browserSelection).toEqual(browserSelection);
  expect(await readFile(path.join(stale, "private.txt"), "utf-8")).toBe("retained private edits");
  expect(credential).toHaveBeenCalledOnce();
  expect(policies.at(-1)).toBe("allow-all");
  expect(f.events).toEqual([]);
  // Run the real workflow approval callback: a planned successor must ask for fresh consent.
  expect(
    await hooks.approval(
      z.custom<ApprovalContext<ContinuityApprovalToolInput>>().parse({ ...ctx, toolInput: input }),
    ),
  ).toBe("user-approval");
  const capture = createPrivateContinuityApprovalCapture({
    plan: successor.plan,
    request: successor.request,
    principal: { ...authority, scopes: ["autograph:send"] },
    callId: ctx.callId,
  });
  f.deps.readApproval = async () => capture.read();
  expect(await f.operations.approval(context, successor.request)).toEqual({ approved: false });
  const approvalEvent: MessageStreamEvent = {
    type: "input.requested",
    meta: { at: "2026-11-03T00:00:00Z", id: "request-event" },
    data: {
      sequence: 1,
      stepIndex: 0,
      turnId: "retained-turn",
      requests: [
        {
          kind: "tool-approval",
          requestId: "fresh-approval",
          prompt: "Run focused acceptance",
          action: {
            kind: "tool-call",
            toolName: "run-app-continuity-tests",
            callId: ctx.callId,
            input,
          },
        },
      ],
    },
  };
  // Exercise the actual public approval surface before consenting to the managed run.
  const publicRequests = outstandingInstalledEveRequests([approvalEvent]);
  expect(deriveInstalledEveStatus([approvalEvent])).toBe("input_required");
  expect(publicRequests).toMatchObject([{ kind: "approval", requestId: "fresh-approval" }]);
  expect(publicRequests[0]?.description).toBeTruthy();
  expect(
    projectInstalledEveEvent(approvalEvent, 0).some((event) => event.type === "error.public"),
  ).toBe(false);
  capture.observe(approvalEvent);
  expect(capture.read()).toBeNull();
  capture.observe({
    type: "approval.settled",
    meta: { at: "2026-11-03T00:00:01Z", id: "settlement-event" },
    data: {
      sequence: 2,
      stepIndex: 0,
      turnId: "retained-turn",
      requestId: z.string().parse(publicRequests[0]?.requestId),
      responderPrincipalId: authority.ownerUserId,
      outcome: "approved",
    },
  });
  expect(capture.read()?.approvalId).toBe("fresh-approval");
  installManagedAcceptanceSuite(f, successor.plan.runtime.root, fixture, browserSelection);
  const outcome = await continuityTool.execute(input, toolCtx);
  expect(outcome).toMatchObject({ state: "settled" });
  expect(f.rows.get(old.plan.intentId)).toMatchObject({
    ...priorEvidence,
    supersededBy: successor.plan.intentId,
    revision: (priorEvidence?.revision ?? 0) + 1,
  });
  expect(await readFile(path.join(fixture, "durable.txt"), "utf-8")).toBe("preserved-value");
});
