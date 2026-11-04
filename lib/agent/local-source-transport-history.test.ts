import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { Client, ClientSession } from "eve/client";
import type { MessageStreamEvent } from "eve/client";
import { createLocalNativeRecovery } from "../eve/local-native-recovery";
import { nativeRecoveryBindingSchema } from "../eve/native-recovery-contract";
import { localPlanningSourceArchiveFixture } from "../repository/local-planning-source-test-fixture";
import {
  captureLocalPlanningSource,
  reconcileLocalPlanningSource,
} from "../repository/local-planning-source";
import { localPlanningSourceBase } from "./local-planning-source-base";
import {
  completedLocalSourceTransport,
  readCompletedLocalSourceTransport,
} from "./local-source-transport-history";
import { prepareDevelopmentSandboxWorkspace } from "../repository/supported-template";
import { workspacePreparationTransition } from "./workspace-preparation-transition";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const result = (
  output: Awaited<ReturnType<typeof prepareDevelopmentSandboxWorkspace>>,
  status: "completed" | "failed" = "completed",
): MessageStreamEvent => ({
  type: "action.result",
  meta: { at: "2026-11-03T00:00:00Z", id: "transport" },
  data: {
    sequence: 1,
    stepIndex: 0,
    turnId: "turn",
    status,
    result: {
      kind: "tool-result",
      toolName: "prepare_workspace",
      callId: "overlay",
      output: { ...output },
    },
  },
});

test("actual source-preparation service retains old validation workflow while Native receipt recovers its completed dirty source overlay", async () => {
  const f = await localPlanningSourceArchiveFixture();
  try {
    const stateRoot = path.dirname(f.source);
    writeFileSync(path.join(stateRoot, "eve-cycle"), "a".repeat(64), { mode: 0o600 });
    const environment = {
      EVE_AGENT_HOST: "http://127.0.0.1:2100",
      APP_BUILDER_EXECUTION_MODE: "development",
      APP_BUILDER_EXECUTION_BUNDLE: "local-development",
      APP_BUILDER_LOCAL_ADAPTER: "1",
      EVE_HOSTED_ADAPTER: "0",
    };
    const appSpec = { appId: "example", digest: "a".repeat(64), artifactRevision: "b".repeat(64) };
    const sourceReceipt = {
      sourceSha: f.original.sourceSha,
      sourcePath: f.source,
      digest: "c".repeat(64),
      eligibilityDigest: f.original.eligibilityDigest,
      version: 4,
      sourceKind: "template",
    };
    const unsigned = {
      sourceSha: f.original.sourceSha,
      sourceReceiptDigest: sourceReceipt.digest,
      workspaceDigest: f.original.workspaceDigest,
      appSpecDigest: appSpec.digest,
      artifactRevision: appSpec.artifactRevision,
      target: { contract: { appId: appSpec.appId } },
    };
    const proposal = { ...unsigned, digest: hash(JSON.stringify(unsigned)) };
    const workflow = {
      phase: "validation_failed" as const,
      appSpec,
      sourceReceipt,
      workspace: f.original,
      proposal,
    };
    f.write(f.source, "shared.txt", "intermediate dirty shared source\n");
    const output = await prepareDevelopmentSandboxWorkspace(f.source, f.sandbox, "overlay");
    const retained = workspacePreparationTransition(workflow, () => {
      throw new Error("An authored validation workflow must be retained");
    });
    expect(retained).toBe(workflow);
    expect(workflow.workspace.workspaceDigest).toBe(f.original.workspaceDigest);
    expect(output.workspaceDigest).not.toBe(workflow.workspace.workspaceDigest);
    const events = [result(output)];
    const transport = await readCompletedLocalSourceTransport(
      {
        sessionId: "saved-session",
        expected: {
          workspaceId: f.original.workspaceId,
          workspacePath: f.original.workspacePath,
          sourcePath: f.source,
        },
      },
      {
        environment,
        readAuthority: () => Promise.resolve({ kind: "local", ownerUid: 1, stateRoot }),
        snapshot: () =>
          Promise.resolve({
            events,
            session: { sessionId: "saved-session", streamIndex: events.length },
          }),
      },
    );
    const baseline = localPlanningSourceBase(workflow, transport);
    expect(baseline.sourceOverlay?.workspaceDigest).toBe(output.workspaceDigest);
    f.write(f.source, "shared.txt", "current repaired shared source\n");
    const capture = await captureLocalPlanningSource(f.source, baseline.sourceSha);
    try {
      await reconcileLocalPlanningSource({
        sandbox: f.sandbox,
        assertCurrent: () => {},
        appId: appSpec.appId,
        sessionId: "saved-session",
        callId: "new-plan",
        originalSourceSha: baseline.sourceSha,
        originalWorkspaceDigest: baseline.workspaceDigest,
        workspaceId: baseline.workspaceId,
        sourceOverlay: baseline.sourceOverlay,
        receipt: {
          sourceSha: capture.sourceSha,
          sourceTree: capture.generation.generation,
          eligibilityDigest: capture.generation.eligibilityDigest,
        },
        capture,
      });
      expect(readFileSync(path.join(f.candidate, "shared.txt"), "utf-8")).toBe(
        "current repaired shared source\n",
      );
      expect(readFileSync(path.join(f.candidate, "apps/example/app/page.tsx"), "utf-8")).toBe(
        "saved private app\n",
      );
      expect(
        readFileSync(
          path.join(f.candidate, "apps/example/schema/release/v1/release.json"),
          "utf-8",
        ),
      ).toBe("saved immutable release\n");
    } finally {
      capture.dispose();
    }
  } finally {
    f.dispose();
  }
});

test("failed tool results, observed metadata and foreign/incomplete history cannot authorize source recognition", async () => {
  const f = await localPlanningSourceArchiveFixture();
  try {
    const stateRoot = path.dirname(f.source);
    writeFileSync(path.join(stateRoot, "eve-cycle"), "a".repeat(64), { mode: 0o600 });
    const environment = {
      EVE_AGENT_HOST: "http://127.0.0.1:2100",
      APP_BUILDER_EXECUTION_MODE: "development",
      APP_BUILDER_EXECUTION_BUNDLE: "local-development",
      APP_BUILDER_LOCAL_ADAPTER: "1",
      EVE_HOSTED_ADAPTER: "0",
    };
    const expected = {
      workspaceId: f.original.workspaceId,
      workspacePath: f.original.workspacePath,
      sourcePath: f.source,
    };
    expect(completedLocalSourceTransport([result(f.original, "failed")], expected)).toBeUndefined();
    expect(() =>
      completedLocalSourceTransport([result({ ...f.original, workspaceId: "foreign" })], expected),
    ).toThrow("another workspace");
    await expect(
      readCompletedLocalSourceTransport(
        { sessionId: "saved-session", expected },
        {
          environment,
          readAuthority: () => Promise.resolve({ kind: "local", ownerUid: 1, stateRoot }),
          snapshot: () =>
            Promise.resolve({
              events: [],
              session: { sessionId: "saved-session", streamIndex: 2 },
            }),
        },
      ),
    ).rejects.toThrow("incomplete");
    const observedMetadata = result(f.original);
    if (
      observedMetadata.type === "action.result" &&
      observedMetadata.data.result.kind === "tool-result"
    ) {
      const statusOnly: MessageStreamEvent = {
        ...observedMetadata,
        data: {
          ...observedMetadata.data,
          result: { ...observedMetadata.data.result, toolName: "workspace_status" },
        },
      };
      expect(completedLocalSourceTransport([statusOnly], expected)).toBeUndefined();
    }
    await expect(
      readCompletedLocalSourceTransport(
        { sessionId: "saved-session", ownerRunId: "foreign-child", expected },
        {
          environment,
          readAuthority: () => Promise.resolve({ kind: "local", ownerUid: 1, stateRoot }),
          snapshot: () =>
            Promise.reject(new Error("Snapshot must not be read under a foreign owner")),
        },
      ),
    ).rejects.toThrow("owner changed");
    let reads = 0;
    await expect(
      readCompletedLocalSourceTransport(
        { sessionId: "saved-session", expected },
        {
          environment,
          readAuthority: () => {
            reads += 1;
            return Promise.resolve({ kind: "local", ownerUid: reads, stateRoot });
          },
          snapshot: () =>
            Promise.resolve({
              events: [],
              session: { sessionId: "saved-session", streamIndex: 0 },
            }),
        },
      ),
    ).rejects.toThrow("owner changed");
  } finally {
    f.dispose();
  }
});

test("missing cycle variable uses the same owned cycle and stitches actual SDK history instead of selecting the old transport", async () => {
  const f = await localPlanningSourceArchiveFixture();
  const stateRoot = path.dirname(f.source);
  const cycle = path.join(stateRoot, "eve-cycle");
  writeFileSync(cycle, "a".repeat(64), { mode: 0o600 });
  const environment = {
    EVE_AGENT_HOST: "http://127.0.0.1:2100",
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    EVE_HOSTED_ADAPTER: "0",
  };
  const recovery = createLocalNativeRecovery({
    ...environment,
    APP_BUILDER_LOCAL_EVE_CYCLE_FILE: cycle,
  });
  if (!recovery) {
    throw new Error("Missing fixture recovery");
  }
  const expected = {
    workspaceId: f.original.workspaceId,
    workspacePath: f.original.workspacePath,
    sourcePath: f.source,
  };
  f.write(f.source, "shared.txt", "genuine later source overlay\n");
  const overlay = await prepareDevelopmentSandboxWorkspace(f.source, f.sandbox, "overlay");
  const snapshot = vi
    .spyOn(ClientSession.prototype, "snapshot")
    .mockImplementation(function read(this: ClientSession) {
      const events: MessageStreamEvent[] =
        this.state.sessionId === "saved-session"
          ? [
              result(f.original),
              {
                type: "session.failed",
                meta: { at: "2026-11-03T00:00:00Z", id: "failed" },
                data: { code: "model_error", message: "Failed model", sessionId: "saved-session" },
              },
            ]
          : [result(overlay)];
      return Promise.resolve({
        events,
        session: { sessionId: this.state.sessionId, streamIndex: events.length },
      });
    });
  try {
    const native = new Client({ host: environment.EVE_AGENT_HOST });
    await recovery.recover(native, "saved-session", "explicit-resume", async (body) => {
      const binding = nativeRecoveryBindingSchema.parse({
        ...body.recovery,
        ownerRunId: "recovered-session",
        provenance: {
          kind: "failed-turn-input",
          sourceStepId: "failed-step",
          sourceEventId: "failed",
          sourceSlot: 0,
          checkpointVersion: 1,
        },
      });
      const call = {
        auth: {
          ...body.forwardedPrincipal.current,
          attributes: { "eve:forwarded-by": "local-dev" },
        },
        descriptor: body.recovery,
      };
      await (body.recoveryPhase === "activate"
        ? recovery.ports.authorizeActivation(call)
        : recovery.ports.commitReceipt({ ...call, recoveryBinding: binding }));
      return { sessionId: binding.ownerRunId, recoveryBinding: binding };
    });
    const plain = await native.sessions.attach("saved-session").snapshot();
    expect(completedLocalSourceTransport(plain.events, expected)?.workspaceDigest).toBe(
      f.original.workspaceDigest,
    );
    const dependencies = {
      environment,
      readAuthority: () =>
        Promise.resolve({ kind: "local" as const, ownerUid: process.getuid?.() ?? 0, stateRoot }),
    };
    const stitched = await readCompletedLocalSourceTransport(
      { sessionId: "saved-session", expected },
      dependencies,
    );
    expect(stitched?.workspaceDigest).toBe(overlay.workspaceDigest);
    // Actual Eve SessionContext: the callback workflow differs from its trusted
    // prepared-session stream anchor after supported native recovery.
    const callback = await readCompletedLocalSourceTransport(
      {
        sessionId: "saved-session",
        ownerRunId: "callback-step-owner",
        ownerAnchorRunId: "recovered-session",
        expected,
      },
      dependencies,
    );
    expect(callback?.workspaceDigest).toBe(overlay.workspaceDigest);
    await expect(
      readCompletedLocalSourceTransport(
        {
          sessionId: "saved-session",
          ownerRunId: "callback-step-owner",
          ownerAnchorRunId: "foreign-anchor",
          expected,
        },
        dependencies,
      ),
    ).rejects.toThrow("owner changed");
    await expect(
      readCompletedLocalSourceTransport(
        { sessionId: "saved-session", ownerAnchorRunId: "recovered-session", expected },
        dependencies,
      ),
    ).rejects.toThrow("owner changed");
    await expect(
      readCompletedLocalSourceTransport(
        { sessionId: "saved-session", ownerRunId: "callback-step-owner", expected },
        dependencies,
      ),
    ).rejects.toThrow("owner changed");

    await expect(
      readCompletedLocalSourceTransport(
        { sessionId: "saved-session", expected },
        {
          ...dependencies,
          environment: {
            ...environment,
            APP_BUILDER_LOCAL_EVE_CYCLE_FILE: path.join(stateRoot, "missing-cycle"),
          },
        },
      ),
    ).rejects.toThrow();
    await expect(
      readCompletedLocalSourceTransport(
        { sessionId: "saved-session", expected },
        {
          ...dependencies,
          environment: {
            ...environment,
            APP_BUILDER_LOCAL_EVE_CYCLE_FILE: path.join(f.source, "foreign-cycle"),
          },
        },
      ),
    ).rejects.toThrow("another owner");
  } finally {
    snapshot.mockRestore();
    f.dispose();
  }
});
