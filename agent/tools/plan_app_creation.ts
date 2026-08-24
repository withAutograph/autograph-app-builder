import { defineTool } from "eve/tools";
import { z } from "zod";

import { appBuilderWorkflowState, sha256 } from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Derive a canonical read-only AppSpec-bound creation proposal from the durable accepted AppSpec. It does not run target-owned commands or modify the repository.",
  inputSchema: z.object({
    expectedAppSpecDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  async execute({ expectedAppSpecDigest }) {
    const current = appBuilderWorkflowState.get();
    if (current.phase === "empty" || current.phase === "prepared")
      throw new Error(
        "Accept a build-ready AppSpec before planning app creation.",
      );
    if (current.appSpec.digest !== expectedAppSpecDigest)
      throw new Error("The accepted AppSpec changed before planning.");
    if (current.phase === "planned") return current.proposal;
    const appSpec = {
      path: `prototype/${current.appSpec.appId}/app-spec.md`,
      sha256: current.appSpec.digest,
    };
    const proposal = {
      version: 1 as const,
      appId: current.appSpec.appId,
      appSpec,
      sourceSha: current.workspace.sourceSha,
      eligibilityDigest: current.workspace.eligibilityDigest,
      workspaceDigest: current.workspace.workspaceDigest,
      commands: {
        planning:
          "mise run repository:exec -- app-contract.ts --contract <contract-file>",
        apply: "mise run create:app -- --proposal <proposal-file>",
        preflight: "mise run repository:preflight",
        validation: ["mise run check", "mise run test"],
      },
      mutations: [] as [],
    };
    const complete = { ...proposal, digest: sha256(JSON.stringify(proposal)) };
    appBuilderWorkflowState.update(() => ({
      version: 1,
      phase: "planned",
      workspace: current.workspace,
      appSpec: current.appSpec,
      proposal: complete,
    }));
    return complete;
  },
});
