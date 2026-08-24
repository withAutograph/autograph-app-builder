import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

const appSpec = `## Status and prototype

Accepted prototype.

## User and outcome

Confirmed outcome.

## Interfaces and navigation

Confirmed interface.

## Controls and behavior

Confirmed behavior.

## Data model

No owned data.

## Integrations and reconciliation

No integrations.

## Temporal semantics

No temporal behavior.

## Writes, review, and authority

No writes before separate approval.

## Access and tenancy

Confirmed tenancy.

## Agent behavior

Agent prepares proposals only.

## Operational states

Empty and error states are defined.

## Defaults, non-goals, and risks

No providers or deployment.

## Acceptance walkthrough

User accepted this AppSpec.

## Build handoff

\`\`\`json
{
  "status": "build-ready",
  "owner": "finance-platform",
  "schema": { "kind": "none" },
  "additionalPublicRoutes": [],
  "optionalCapabilities": {
    "integrations": [],
    "hostedResources": []
  }
}
\`\`\``;

export default defineEval({
  description:
    "AppSpec acceptance is approval-bound and yields a durable read-only proposal without executing target commands.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();

    await t.send(`Prepare supported repository at ${repository}`);
    t.requireInputRequest({ toolName: "prepare_workspace" });
    await t.respondAll("approve");
    t.succeeded();

    await t.send("Assess workspace readiness before planning.");
    t.succeeded();
    t.calledTool("workspace_readiness_status", { count: 1 });
    t.check(t.reply, includes("not ready for target execution"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send(`Accept build-ready AppSpec for expense-review:\n${appSpec}`);
    t.requireInputRequest({ toolName: "accept_app_spec" });
    await t.respondAll("approve");
    t.succeeded();
    t.calledTool("accept_app_spec", { count: 1 });
    t.calledTool("plan_app_creation", { count: 1 });
    t.check(t.reply, includes("digest-bound read-only creation proposal"));
    t.check(t.reply, includes("No target command has run"));

    await t.send(
      "Assess target command readiness for the current creation proposal.",
    );
    t.succeeded();
    t.calledTool("target_execution_status", { count: 1 });
    t.check(t.reply, includes("not ready for a target command"));
    t.check(t.reply, includes("no target command was run"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Assess target command readiness with stale proposal digest.");
    t.succeeded();
    t.calledTool("target_execution_status", { count: 1 });
    t.check(t.reply, includes("rejected the stale proposal"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
