import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { evidencePrefix, sanitizeEvidence } from "./support/self-reproduction-evidence";

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

    await send("Prepare offline target dependencies.");
    t.succeeded();

    await send("Run target identity and planning.");
    t.succeeded();

    await send("Apply the current creation proposal.");
    if (
      t.pendingInputRequests.length !== 1 ||
      t.pendingInputRequests[0]?.action.toolName !== "apply_app_creation"
    )
      throw new Error("Expected one apply_app_creation approval request.");
    emit({ kind: "response", request: "apply_app_creation", response: "approve" });
    await t.respondAll("approve");
    t.succeeded();

    const workflow = await send("Report the current artifact workflow status without changing it.");
    t.succeeded();
    let phase = (
      workflow.toolCalls.find(
        (call) => call.name === "artifact_workflow_status" && call.status === "completed",
      )?.output as { phase?: unknown } | undefined
    )?.phase;
    if (phase === "applied" || phase === "validation_pending") {
      await send("Validate the applied creation, then report artifact workflow status.");
      t.succeeded();
      const refreshed = await send(
        "Report the current artifact workflow status without changing it.",
      );
      t.succeeded();
      phase = (
        refreshed.toolCalls.find(
          (call) => call.name === "artifact_workflow_status" && call.status === "completed",
        )?.output as { phase?: unknown } | undefined
      )?.phase;
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

    t.check(
      phase,
      satisfies(
        (value) => value === "validated" || value === "reviewed",
        "the generated candidate reached validated or reviewed state",
      ),
    );

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
