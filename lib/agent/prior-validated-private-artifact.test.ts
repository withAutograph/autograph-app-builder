/* oxlint-disable sonarjs/no-internal-api-use, anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions, typescript/no-confusing-void-expression -- Fixtures exercise actual Eve context and receipt consumers, with only the Sandbox snapshot port simulated. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { developmentExecutionEnvironment } from "../development/execution-environment.mjs";
import { privateApplyDenialEvents } from "../eve/private-apply-denial.test-fixture";
import { canonicalOverlayFiles, OVERLAY_SNAPSHOT_SCRIPT } from "../repository/target-apply";
import type { TargetApplyReceipt } from "../repository/target-apply";
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

const seed = (denied = true) => {
  for (const [key, value] of Object.entries(developmentExecutionEnvironment)) {
    vi.stubEnv(key, value);
  }
  const appId = "example";
  const sessionId = "owned";
  const appSpec = { appId, digest: "a".repeat(64), artifactPath: "app-spec.md" };
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
    version: 17,
    appSpec,
    workspace,
    sourceReceipt,
    identityReceipt: { identity: { appId } },
  };
  const current = {
    ...common,
    phase: "planned",
    proposal: proposal("current"),
  } as unknown as Extract<AppBuilderWorkflowState, { phase: "planned" }>;
  const priorProposal = proposal("previous");
  const file = {
    path: "apps/example/app/page.tsx",
    mode: "644",
    digest: sha256("validated bytes"),
  };
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
    postTreeDigest: sha256(JSON.stringify(canonicalOverlayFiles([file]))),
  }) as unknown as TargetApplyReceipt;
  const validationReceipt = sign({
    ...validationBinding(applyReceipt, []),
    version: 3,
    status: "passed",
    commands: [{ name: "test", exitCode: 0 }],
  });
  const prior = {
    ...common,
    phase: "validated",
    proposal: priorProposal,
    applyReceipt,
    validationReceipt,
  } as unknown as Extract<AppBuilderWorkflowState, { phase: "validated" }>;
  appBuilderWorkflowState.update(() => current);
  existingAppRepairHistory.update(() => [
    {
      proposalDigest: current.proposal.digest,
      sessionId,
      requestDigest: "f".repeat(64),
      previousWorkflow: prior,
      approvedBase: prior,
    },
  ]);
  const scope = {
    appId,
    appSpecDigest: appSpec.digest,
    workspaceId: workspace.workspaceId,
    sessionId,
  };
  const previousScope = { ...scope, proposalDigest: priorProposal.digest };
  requestPrivateApplyApproval(previousScope, "approved");
  recordApprovedPrivateApply(previousScope, "approved");
  const currentScope = { ...scope, proposalDigest: current.proposal.digest };
  requestPrivateApplyApproval(currentScope, "denied-call");
  if (denied) {
    for (const event of privateApplyDenialEvents()) {
      observePrivateApplyDecisionEvent(
        event as Parameters<typeof observePrivateApplyDecisionEvent>[0],
        sessionId,
      );
    }
  }
  const result = (mode = file.mode, digest = file.digest) => ({
    exitCode: 0,
    stdout: `${mode}\t${digest}\t${file.path}\n`,
    stderr: "",
  });
  const run = vi.fn(() => Promise.resolve(result()));
  const sandbox = { id: workspace.workspaceId, run } as unknown as SandboxSession;
  return {
    input: { appId, sessionId, sandbox, state: current },
    current,
    prior,
    currentScope,
    run,
    result,
  };
};

it("selects only the denied plan's last validated private bytes without rewriting history", async () =>
  await own(async () => {
    const f = seed();
    const retained = [readPrivateApplyAuthority(), existingAppRepairHistory.get()];
    const selected = await priorValidatedPrivateArtifact(f.input);
    expect(selected).toMatchObject({
      root: "/workspace/repository",
      revision: f.prior.applyReceipt.digest,
      validationDigest: f.prior.validationReceipt.digest,
    });
    expect(f.run).toHaveBeenCalledOnce();
    expect(appBuilderWorkflowState.get()).toEqual(f.current);
    expect([readPrivateApplyAuthority(), existingAppRepairHistory.get()]).toEqual(retained);
  }));

it("denies pending approval, a current grant or a foreign owner before the Sandbox read", async () =>
  await own(async () => {
    const f = seed(false);
    await expect(priorValidatedPrivateArtifact(f.input)).rejects.toThrow("cannot be verified");
    recordApprovedPrivateApply(f.currentScope, "denied-call");
    await expect(priorValidatedPrivateArtifact(f.input)).rejects.toThrow("cannot be verified");
    await expect(
      priorValidatedPrivateArtifact({ ...f.input, sessionId: "foreign" }),
    ).rejects.toThrow("cannot be verified");
    expect(f.run).not.toHaveBeenCalled();
  }));

it.each(["mode", "content", "authority"])(
  "refuses checkout %s drift",
  async (drift) =>
    await own(async () => {
      const f = seed();
      const selected = await priorValidatedPrivateArtifact(f.input);
      f.run.mockImplementationOnce(() => {
        if (drift === "authority") {
          requestPrivateApplyApproval(f.currentScope, "new-pending");
        }
        return Promise.resolve(
          f.result(
            drift === "mode" ? "755" : undefined,
            drift === "content" ? sha256("foreign bytes") : undefined,
          ),
        );
      });
      await expect(selected.verifyCurrent()).rejects.toThrow("cannot be verified");
    }),
);

it("rejects source symlinks in strict overlay verification before accepting a digest", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "builder-prior-overlay-")));
  try {
    writeFileSync(path.join(root, "source.js"), "source");
    const program = `const expectedOverlayRoot = ${JSON.stringify(root)};\n${OVERLAY_SNAPSHOT_SCRIPT}`;
    const snapshot = () =>
      spawnSync(process.execPath, ["-e", program], { cwd: root, encoding: "utf-8" });
    expect(snapshot().status).toBe(0);
    symlinkSync("source.js", path.join(root, "extra.js"));
    const denied = snapshot();
    expect(denied.status).toBe(1);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).toContain("Applied overlay contains an unsupported source entry.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
