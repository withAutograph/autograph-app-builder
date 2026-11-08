/* oxlint-disable sonarjs/no-internal-api-use, anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions, typescript/no-confusing-void-expression -- Fixtures exercise actual Eve context and receipt consumers, with only the Sandbox snapshot port simulated. */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { developmentExecutionEnvironment } from "../development/execution-environment.mjs";
import { privateApplyDenialEvents } from "../eve/private-apply-denial.test-fixture";
import { canonicalOverlayFiles, OVERLAY_SNAPSHOT_SCRIPT } from "../repository/target-apply";
import type { OverlayFile, TargetApplyReceipt } from "../repository/target-apply";
import { validationBinding } from "../repository/target-validation";
import { existingAppRepairHistory } from "./existing-app-repair-planning";
import { observePrivateApplyDecisionEvent } from "./private-apply-decision-lifecycle";
import {
  readPrivateApplyAuthority,
  recordApprovedPrivateApply,
  requestPrivateApplyApproval,
} from "./private-apply-authority";
import { priorValidatedPrivateArtifact } from "./prior-validated-private-artifact";
import { appBuilderWorkflowState, sha256 } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";

afterEach(() => vi.unstubAllEnvs());

const own = (operation: () => Promise<void>) =>
  contextStorage.run(new ContextContainer(), operation);
const sign = <T extends object>(body: T) => ({ ...body, digest: sha256(JSON.stringify(body)) });

const sourceFile = {
  digest: sha256("validated bytes"),
  mode: "644",
  path: "apps/example/app/page.tsx",
};

// oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep fixture helpers scoped to their test or fixture instance.
const seed = (
  approval: "denied" | "pending" | "not-requested" = "denied",
  files: readonly OverlayFile[] = [sourceFile],
) => {
  for (const [key, value] of Object.entries(developmentExecutionEnvironment)) {
    vi.stubEnv(key, value);
  }
  const appId = "example";
  const sessionId = "owned";
  const appSpec = { appId, artifactPath: "app-spec.md", digest: "a".repeat(64) };
  const sourceReceipt = { digest: "c".repeat(64) };
  const workspace = {
    workspaceId: "sandbox",
    workspacePath: "/workspace/repository",
    workspaceDigest: "b".repeat(64),
    sourceSha: "f".repeat(40),
  };
  const contract = { appId, appSpec: { sha256: appSpec.digest } };
  const changes = [{ path: "apps/example/app/page.tsx" }];
  const target = {
    operation: "iterate-existing-app",
    contract,
    iteration: { changes, digest: sha256(JSON.stringify(changes)) },
  };
  const proposal = (callId: string) =>
    sign({
      appSpecDigest: appSpec.digest,
      workspaceDigest: workspace.workspaceDigest,
      sourceReceiptDigest: sourceReceipt.digest,
      contractDigest: sha256(JSON.stringify(contract)),
      target,
      plannedByCallId: callId,
    });
  const common = {
    appSpec,
    identityReceipt: { identity: { appId } },
    sourceReceipt,
    version: 17,
    workspace,
  };
  const current = {
    ...common,
    phase: "planned",
    proposal: proposal("current"),
  } as unknown as Extract<AppBuilderWorkflowState, { phase: "planned" }>;
  const priorProposal = proposal("previous");
  const postTree = canonicalOverlayFiles(files);
  const applyReceipt = sign({
    version: 2,
    status: "applied",
    appSpecDigest: appSpec.digest,
    appSpecPath: appSpec.artifactPath,
    preparedTreeDigest: "d".repeat(64),
    applyRoot: workspace.workspacePath,
    workspaceDigest: workspace.workspaceDigest,
    sourceReceiptDigest: sourceReceipt.digest,
    sourceSha: workspace.sourceSha,
    targetReceipt: { appId },
    proposalDigest: priorProposal.digest,
    postTree,
    postTreeDigest: sha256(JSON.stringify(postTree)),
  }) as unknown as TargetApplyReceipt;
  const validationReceipt = sign({
    ...validationBinding(applyReceipt, []),
    version: 3,
    status: "passed",
    commands: [{ name: "test", exitCode: 0 }],
  });
  const prior = {
    ...common,
    applyReceipt,
    phase: "validated",
    proposal: priorProposal,
    validationReceipt,
  } as unknown as Extract<AppBuilderWorkflowState, { phase: "validated" }>;
  appBuilderWorkflowState.update(() => current);
  existingAppRepairHistory.update(() => [
    {
      approvedBase: prior,
      previousWorkflow: prior,
      proposalDigest: current.proposal.digest,
      requestDigest: "f".repeat(64),
      sessionId,
    },
  ]);
  const scope = {
    appId,
    appSpecDigest: appSpec.digest,
    sessionId,
    workspaceId: workspace.workspaceId,
  };
  const previousScope = { ...scope, proposalDigest: priorProposal.digest };
  requestPrivateApplyApproval(previousScope, "approved");
  recordApprovedPrivateApply(previousScope, "approved");
  const currentScope = { ...scope, proposalDigest: current.proposal.digest };
  if (approval !== "not-requested") {
    requestPrivateApplyApproval(currentScope, "denied-call");
  }
  if (approval === "denied") {
    for (const event of privateApplyDenialEvents()) {
      observePrivateApplyDecisionEvent(
        event as Parameters<typeof observePrivateApplyDecisionEvent>[0],
        sessionId,
      );
    }
  }
  const result = (observed: readonly OverlayFile[] = postTree) => ({
    exitCode: 0,
    stderr: "",
    stdout: observed.map(({ mode, digest, path }) => `${mode}\t${digest}\t${path}\n`).join(""),
  });
  const run = vi.fn(() => Promise.resolve(result()));
  const unexpectedSandboxOperation = () => {
    throw new Error("Unexpected sandbox operation");
  };
  const sandbox: SandboxSession & { id: string } = {
    id: workspace.workspaceId,
    readBinaryFile: unexpectedSandboxOperation,
    readFile: unexpectedSandboxOperation,
    readTextFile: unexpectedSandboxOperation,
    removePath: unexpectedSandboxOperation,
    resolvePath: unexpectedSandboxOperation,
    run,
    spawn: unexpectedSandboxOperation,
    writeBinaryFile: unexpectedSandboxOperation,
    writeFile: unexpectedSandboxOperation,
    writeTextFile: unexpectedSandboxOperation,
  };
  return {
    current,
    currentScope,
    input: { appId, sandbox, sessionId, state: current },
    prior,
    result,
    run,
  };
};

it("selects only the denied plan's last validated private bytes without rewriting history", async () =>
  await own(async () => {
    const f = seed();
    const retained = [readPrivateApplyAuthority(), existingAppRepairHistory.get()];
    const selected = await priorValidatedPrivateArtifact(f.input);
    expect(selected).toMatchObject({
      revision: f.prior.applyReceipt.digest,
      root: "/workspace/repository",
      validationDigest: f.prior.validationReceipt.digest,
    });
    expect(f.run).toHaveBeenCalledOnce();
    expect(appBuilderWorkflowState.get()).toEqual(f.current);
    expect([readPrivateApplyAuthority(), existingAppRepairHistory.get()]).toEqual(retained);
  }));

it("opens the prior approved app while a newer draft has never requested approval", async () =>
  await own(async () => {
    const f = seed("not-requested");
    const retained = readPrivateApplyAuthority();
    await expect(priorValidatedPrivateArtifact(f.input)).resolves.toMatchObject({
      revision: f.prior.applyReceipt.digest,
    });
    expect(readPrivateApplyAuthority()).toEqual(retained);
  }));

it("keeps the approved app available after a second unapplied revision", async () =>
  await own(async () => {
    const f = seed("not-requested");
    existingAppRepairHistory.update((history) =>
      history.map((entry) => ({ ...entry, previousWorkflow: f.current })),
    );
    await expect(priorValidatedPrivateArtifact(f.input)).resolves.toMatchObject({
      revision: f.prior.applyReceipt.digest,
    });
  }));

it("denies pending approval, a current grant or a foreign owner before the Sandbox read", async () =>
  await own(async () => {
    const f = seed("pending");
    await expect(priorValidatedPrivateArtifact(f.input)).rejects.toThrow("cannot be verified");
    recordApprovedPrivateApply(f.currentScope, "denied-call");
    await expect(priorValidatedPrivateArtifact(f.input)).rejects.toThrow("cannot be verified");
    await expect(
      priorValidatedPrivateArtifact({ ...f.input, sessionId: "foreign" }),
    ).rejects.toThrow("cannot be verified");
    expect(f.run).not.toHaveBeenCalled();
  }));

it.each([
  { drift: "content", observed: [{ ...sourceFile, digest: sha256("foreign bytes") }] },
  { drift: "rename", observed: [{ ...sourceFile, path: "apps/example/app/other.tsx" }] },
  { drift: "additional path", observed: [sourceFile, { ...sourceFile, path: "extra.tsx" }] },
  { drift: "missing path", observed: [] },
  { drift: "authority", observed: [sourceFile] },
])(
  "refuses checkout $drift drift",
  async ({ drift, observed }) =>
    await own(async () => {
      const f = seed();
      const selected = await priorValidatedPrivateArtifact(f.input);
      f.run.mockImplementationOnce(() => {
        if (drift === "authority") {
          requestPrivateApplyApproval(f.currentScope, "new-pending");
        }
        return Promise.resolve(f.result(observed));
      });
      await expect(selected.verifyCurrent()).rejects.toThrow("cannot be verified");
    }),
);

it("keeps the same prior artifact available after unrelated workflow diagnostics change", async () =>
  await own(async () => {
    const f = seed();
    const selected = await priorValidatedPrivateArtifact(f.input);
    appBuilderWorkflowState.update(() => ({ ...f.current, checkoutDependencyAttempts: [] }));
    await expect(selected.verifyCurrent()).resolves.toBeUndefined();
  }));

it("accepts mode-only changes on both workspace bins and rechecks only paths and bytes", async () =>
  await own(async () => {
    const paths = [
      "packages/microfrontends-shell/scripts/vercel-service-cli.mjs",
      "packages/microfrontends/scripts/vercel-service-cli.mjs",
    ];
    const bins = paths.map((path) => ({ digest: sha256(path), mode: "755", path }));
    const f = seed("denied", [sourceFile, ...bins]);
    const retained = [readPrivateApplyAuthority(), existingAppRepairHistory.get()];
    f.run.mockResolvedValue(
      f.result([sourceFile, ...bins.map((file) => ({ ...file, mode: "777" }))]),
    );
    const selected = await priorValidatedPrivateArtifact(f.input);
    f.run.mockResolvedValue(
      f.result([sourceFile, ...bins.map((file) => ({ ...file, mode: "644" }))]),
    );
    await expect(selected.verifyCurrent()).resolves.toBeUndefined();
    expect(f.run).toHaveBeenCalledTimes(2);
    expect([readPrivateApplyAuthority(), existingAppRepairHistory.get()]).toEqual(retained);
  }));

it("rejects source symlinks in strict overlay verification before accepting a digest", () => {
  const root = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "builder-prior-overlay-")));
  try {
    const file = nodePath.join(root, "source.js");
    writeFileSync(file, "source");
    chmodSync(file, 0o755);
    const program = `const expectedOverlayRoot = ${JSON.stringify(root)};\n${OVERLAY_SNAPSHOT_SCRIPT}`;
    const snapshot = () =>
      spawnSync(process.execPath, ["-e", program], { cwd: root, encoding: "utf-8" });
    const before = snapshot();
    expect(before.status).toBe(0);
    expect(before.stdout).toMatch(/^000	/u);
    chmodSync(file, 0o777);
    expect(snapshot().stdout).toBe(before.stdout);
    symlinkSync("source.js", nodePath.join(root, "extra.js"));
    const denied = snapshot();
    expect(denied.status).toBe(1);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).toContain("Applied overlay contains an unsupported source entry.");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
