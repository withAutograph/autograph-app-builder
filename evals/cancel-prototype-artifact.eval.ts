import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { z } from "zod";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

const workflowStatus = z.object({
  phase: z.string(),
  appSpec: z.object({ artifactRevision: z.string(), digest: z.string(), path: z.string() }),
  proposal: z.object({ digest: z.string() }),
  dependencies: z.object({ digest: z.string() }),
  identity: z.object({ digest: z.string() }),
  artifacts: z.array(z.object({ path: z.string(), revision: z.string(), digest: z.string() })),
});
const readStatus = (message: string) =>
  workflowStatus.parse(JSON.parse(message.slice(message.indexOf("{"))));

export default defineEval({
  description:
    "Draft artifact revisions preserve the accepted AppSpec and prepared facts without a user-input prompt.",
  async test(t) {
    const session = await t.session();
    const repository = createSupportedRepositoryFixture();

    await session.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    await session.send(`Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`);
    t.succeeded();

    const beforeTurn = await session.send("Report artifact workflow status.");
    t.succeeded();
    const before = readStatus(z.string().parse(beforeTurn.message));
    t.calledTool("artifact_workflow_status", { count: 2 });
    await session.send("Record a replacement prototype artifact.");
    t.succeeded();
    t.notEvent("input.requested");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const turn2 = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 2 });
    t.check(
      turn2.message,
      satisfies((message) => {
        const after = readStatus(z.string().parse(message));
        const priorArtifact = before.artifacts.find(
          (artifact) => artifact.path === before.appSpec.path,
        );
        const recorded = after.artifacts.find((artifact) => artifact.path === before.appSpec.path);
        if (recorded === undefined || priorArtifact === undefined) {
          return false;
        }
        return [
          after.phase === before.phase,
          after.appSpec.digest === before.appSpec.digest,
          after.appSpec.path === before.appSpec.path,
          after.appSpec.artifactRevision === before.appSpec.artifactRevision,
          after.proposal.digest === before.proposal.digest,
          after.dependencies.digest === before.dependencies.digest,
          after.identity.digest === before.identity.digest,
          recorded.revision !== priorArtifact.revision,
          recorded.digest !== priorArtifact.digest,
          recorded.revision !== after.appSpec.artifactRevision,
        ].every(Boolean);
      }, "recording a draft preserves accepted spec and prepared facts while recording a new revision"),
    );
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
