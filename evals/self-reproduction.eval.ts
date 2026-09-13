import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { evidencePrefix, sanitizeEvidence } from "./support/self-reproduction-evidence";
import { assertAcceptedAppSpec } from "./support/self-reproduction-prerequisites";

export default defineEval({
  tags: ["self-reproduction", "sandbox", "live-model"],
  timeoutMs: 900_000,
  description:
    "The live App Builder model creates an independent App Builder replica from the checked-in product brief.",
  async test(t) {
    const emit = (record: Record<string, unknown>) =>
      t.log(
        `${evidencePrefix}${JSON.stringify(sanitizeEvidence({ at: new Date().toISOString(), ...record }))}`,
      );
    const send = async (prompt: string) => {
      emit({ kind: "prompt", prompt });
      const started = Date.now();
      const live = await t.start(prompt);
      let observed = 0;
      const checkpoint = () => {
        for (const event of live.events.slice(observed)) emit({ kind: "event", event });
        observed = live.events.length;
      };
      const timer = setInterval(checkpoint, 1000);
      try {
        const turn = await live.result();
        checkpoint();
        emit({
          kind: "turn-completed",
          status: turn.status,
          message: turn.message,
          toolCalls: turn.toolCalls,
          elapsedMs: Date.now() - started,
        });
        turn.expectOk();
        return turn;
      } finally {
        clearInterval(timer);
        checkpoint();
      }
    };
    emit({ kind: "eval-started" });
    const brief = await readFile(
      resolve(process.cwd(), "evals/self-reproduction/brief.md"),
      "utf-8",
    );
    const answers = await readFile(
      resolve(process.cwd(), "evals/self-reproduction/answers.json"),
      "utf-8",
    );
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0)
      throw new Error("The signed self-reproduction source root is missing.");

    await send(
      `Inspect the existing repository at ${repository}. Review this exact source before preparing a workspace.`,
    );
    t.succeeded();
    t.calledTool("inspect_source", { count: 1 });

    await send("Prepare the reviewed repository workspace.");
    t.succeeded();
    t.calledTool("prepare_workspace", { count: 1 });

    await send(
      `${brief}\n\nFixed benchmark answers (use these without asking product questions):\n${answers}\n\nDesign the replica and accept a build-ready AppSpec. Stop before target planning.`,
    );
    t.succeeded();
    t.check(
      t.reply,
      satisfies(
        (reply) => typeof reply === "string" && reply.trim().length > 0,
        "the live model returned a product-facing result",
      ),
    );

    const designStatus = await send(
      "Report the current artifact workflow status without changing it.",
    );
    const status = designStatus.toolCalls.find(
      (call) => call.name === "artifact_workflow_status" && call.status === "completed",
    )?.output;
    try {
      assertAcceptedAppSpec(status);
    } catch (error) {
      emit({ kind: "eval-completed", candidate: { status: "unavailable", reason: String(error) } });
      throw error;
    }

    await send("Prepare target dependencies using the repository's normal installation workflow.");
    t.succeeded();

    await send("Run target identity and planning.");
    t.succeeded();

    const respondAll = async (response: string) => {
      const started = Date.now();
      const before = t.events.length;
      const turn = await t.respondAll(response);
      for (const event of t.events.slice(before)) emit({ kind: "event", event });
      emit({
        kind: "turn-completed",
        status: turn.status,
        message: turn.message,
        toolCalls: turn.toolCalls,
        elapsedMs: Date.now() - started,
      });
      turn.expectOk();
      return turn;
    };
    const approveCurrentBuild = async (prompt: string) => {
      await send(prompt);
      if (t.pendingInputRequests[0]?.action.toolName === "ask_question") {
        emit({ kind: "response", request: "Build this app?", response: "build" });
        await respondAll("build");
        await send("Proceed with the selected build now.");
      }
      const approvePendingApply = async (approvals = 0): Promise<number> => {
        if (
          approvals >= 3 ||
          t.pendingInputRequests.length !== 1 ||
          t.pendingInputRequests[0]?.action.toolName !== "apply_app_creation"
        )
          return approvals;
        emit({ kind: "response", request: "apply_app_creation", response: "approve" });
        await respondAll("approve");
        return approvePendingApply(approvals + 1);
      };
      const approvals = await approvePendingApply();
      if (approvals === 0) throw new Error("Expected one apply_app_creation approval request.");
      if (t.pendingInputRequests.length > 0)
        throw new Error("Apply repair exceeded the bounded approval sequence.");
    };
    const readWorkflowPhase = async () => {
      const turn = await send("Report the current artifact workflow status without changing it.");
      t.succeeded();
      return (
        turn.toolCalls.find(
          (call) => call.name === "artifact_workflow_status" && call.status === "completed",
        )?.output as { phase?: unknown } | undefined
      )?.phase;
    };

    await approveCurrentBuild("Apply the current creation proposal.");
    let phase = await readWorkflowPhase();
    if (phase === "planned" || phase === "apply_failed") {
      await approveCurrentBuild(
        "Repair the implementation using the apply failure already returned by the tool, then apply the current proposal again.",
      );
      phase = await readWorkflowPhase();
    }
    if (phase === "applied" || phase === "validation_pending") {
      await send("Validate the applied creation, then report artifact workflow status.");
      t.succeeded();
      phase = await readWorkflowPhase();
    }
    if (phase === "validation_failed") {
      const failedExport = await send(
        "Validation did not pass. Export the current applied candidate source for diagnosis by calling change_set_status with includeContent true, then report the validation failure without reviewing or accepting it.",
      );
      t.succeeded();
      t.check(
        failedExport.toolCalls,
        satisfies(
          (calls) =>
            Array.isArray(calls) &&
            calls.some(
              (call) =>
                call.name === "change_set_status" &&
                call.status === "completed" &&
                (call.input as { includeContent?: unknown }).includeContent === true &&
                Array.isArray((call.output as { exportFiles?: unknown }).exportFiles),
            ),
          "validation-failed source was exported as unreviewed diagnostic evidence",
        ),
      );
      t.check(
        phase,
        satisfies(
          () => false,
          "the generated candidate passed repository validation before review",
        ),
      );
      emit({
        kind: "eval-completed",
        candidate: {
          status: "available",
          source: "unreviewed validation-failed change_set_status.exportFiles",
        },
      });
      return;
    }

    if (phase !== "validated" && phase !== "reviewed") {
      emit({
        kind: "eval-completed",
        candidate: {
          status: "unavailable",
          reason: `Generation stopped in workflow phase ${String(phase)}.`,
        },
      });
      throw new Error(`Cannot review or export a candidate in workflow phase ${String(phase)}.`);
    }

    if (phase === "validated") {
      await send("Inspect the validated change set.");
      t.succeeded();
    }

    await send("Accept the displayed change set.");
    t.succeeded();

    const reviewedExport = await send(
      "Export the reviewed candidate source by calling change_set_status with includeContent true.",
    );
    t.succeeded();
    t.check(
      reviewedExport.toolCalls,
      satisfies(
        (calls) =>
          Array.isArray(calls) &&
          calls.some(
            (call) =>
              call.name === "change_set_status" &&
              call.status === "completed" &&
              (call.input as { includeContent?: unknown }).includeContent === true &&
              Array.isArray((call.output as { exportFiles?: unknown }).exportFiles),
          ),
        "the reviewed candidate source was exported with file contents",
      ),
    );

    await send("Report artifact workflow status.");
    t.succeeded();
    emit({
      kind: "eval-completed",
      candidate: {
        status: "available",
        source: "change_set_status.exportFiles",
      },
    });
  },
});
