import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  APP_BUILDER_WORKFLOW_STATE_KEY,
  assertExactWorkflowState,
  assertPublicationJournalStatus,
  assertUpstreamMutationAllowed,
  type AppBuilderWorkflowState,
} from "./workflow-state";

const state = (phase: AppBuilderWorkflowState["phase"]) =>
  ({
    version: APP_BUILDER_WORKFLOW_VERSION,
    phase,
  }) as AppBuilderWorkflowState;

describe(`workflow V${APP_BUILDER_WORKFLOW_VERSION} aggregate boundary`, () => {
  it("uses a new durable key so earlier aggregates cannot be reinterpreted", () => {
    expect(APP_BUILDER_WORKFLOW_STATE_KEY).toBe(
      `autograph-app-builder.workflow.v${APP_BUILDER_WORKFLOW_VERSION}`,
    );
    expect(APP_BUILDER_WORKFLOW_STATE_KEY).not.toMatch(/workflow\.v(?:9|10)$/u);
  });

  it.each([
    "publication_pending",
    "publication_failed",
    "published_local",
    "branch_publication_pending",
    "branch_publication_failed",
    "published_branch_worktree",
  ] as const)("rejects upstream mutation in %s", (phase) => {
    expect(() =>
      assertUpstreamMutationAllowed(state(phase), "test mutation"),
    ).toThrow(/permanently disabled/u);
  });

  it("rejects a stale update racing reviewed to publication pending", () => {
    expect(() =>
      assertExactWorkflowState(
        state("publication_pending"),
        state("reviewed"),
        "prototype artifact recording",
      ),
    ).toThrow(/changed concurrently/u);
  });

  it.each([
    ["reviewed", [undefined]],
    ["publication_pending", [undefined, "pending", "failed", "succeeded"]],
    ["publication_failed", [undefined, "failed"]],
    ["published_local", ["succeeded"]],
  ] as const)("accepts canonical %s transaction windows", (phase, allowed) => {
    for (const journal of [
      undefined,
      "pending",
      "failed",
      "succeeded",
    ] as const) {
      const assertion = () => assertPublicationJournalStatus(phase, journal);
      if ((allowed as readonly unknown[]).includes(journal))
        expect(assertion).not.toThrow();
      else expect(assertion).toThrow(/cannot be paired/u);
    }
  });

  it("requires every upstream mutator to use the aggregate guard", async () => {
    const tools = [
      "prepare_workspace",
      "record_prototype_artifact",
      "accept_app_spec",
      "prepare_target_dependencies",
      "plan_app_creation",
      "apply_app_creation",
      "validate_app_creation",
      "accept_change_set",
      "target_execution_status",
      "workspace_readiness_status",
    ];
    for (const tool of tools) {
      const source = await readFile(
        resolve(process.cwd(), `agent/tools/${tool}.ts`),
        "utf8",
      );
      expect(source, tool).toMatch(
        /assertUpstreamMutationAllowed\(\s*(?:current|state),/u,
      );
    }
  });
});
