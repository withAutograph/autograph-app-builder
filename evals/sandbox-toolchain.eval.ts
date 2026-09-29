import { z } from "zod";
import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

const requiredCommands = ["bash", "git", "mise", "bun", "node"] as const;

const toolchainResultSchema = z.object({
  data: z.object({
    result: z.object({
      kind: z.literal("tool-result"),
      output: z.object({
        dependencyCacheDigest: z.string().optional(),
        imageConfiguration: z.string().optional(),
        toolchainReady: z.boolean().optional(),
        tools: z.array(
          z.object({ available: z.boolean(), command: z.string(), version: z.string().optional() }),
        ),
      }),
      toolName: z.literal("inspect_sandbox_toolchain"),
    }),
  }),
  type: z.literal("action.result"),
});
const toolchainDiagnostics = (events: readonly unknown[]) => {
  const results = events.map((event) => toolchainResultSchema.safeParse(event));
  const result = results.findLast((candidate) => candidate.success);
  if (result?.success !== true) {
    return {};
  }
  const receipt = result.data.data.result.output;
  return {
    dependencyCacheDigest: receipt.dependencyCacheDigest,
    imageConfiguration: receipt.imageConfiguration,
    pnpm: receipt.tools.find((tool) => tool.command === "pnpm"),
    toolchainReady: receipt.toolchainReady,
  };
};

const requiredToolsAvailable = (receipt: z.infer<typeof toolchainResultSchema>) =>
  requiredCommands.every((command) =>
    receipt.data.result.output.tools.some(
      (tool) => tool.command === command && tool.available && (tool.version?.length ?? 0) > 0,
    ),
  );

export default defineEval({
  description:
    "The Eve agent reports the current Vercel development Sandbox and prepared toolchain without mutating it.",
  tags: ["sandbox-toolchain", "sandbox-integration"],
  async test(t) {
    const session = await t.session();
    let turn: EveEvalTurn;
    turn = await session.send("Inspect the sandbox toolchain.");
    t.succeeded();
    t.calledTool("inspect_sandbox_toolchain", { count: 1 });
    t.check(turn.message, includes("Sandbox toolchain receipt"));
    t.check(turn.message, includes('"backend":"vercel-development"'));
    t.check(turn.message, includes('"backendBlockers":[]'));
    session.eventsSatisfy("current required tool commands executed successfully", (events) =>
      events.some((event) => {
        const result = toolchainResultSchema.safeParse(event);
        if (!result.success) {
          return false;
        }
        return requiredToolsAvailable(result.data);
      }),
    );
    t.check(turn.message, includes("toolchainReady"));
    t.check(turn.message, includes("backend"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    process.stdout.write(
      `${JSON.stringify({ diagnostics: toolchainDiagnostics(session.events), version: 1 })}\n`,
    );
  },
});
