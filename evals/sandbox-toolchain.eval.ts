import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

const requiredCommands = ["bash", "git", "mise", "bun", "node"] as const;

const toolchainDiagnostics = (events: readonly unknown[]) => {
  for (const event of events.toReversed()) {
    if (typeof event !== "object" || event === null) {
      continue;
    }
    const candidate = event as {
      data?: { result?: { kind?: unknown; output?: unknown; toolName?: unknown } };
      type?: unknown;
    };
    if (
      candidate.type !== "action.result" ||
      candidate.data?.result?.kind !== "tool-result" ||
      candidate.data.result.toolName !== "inspect_sandbox_toolchain"
    ) {
      continue;
    }
    const { output } = candidate.data.result;
    if (typeof output !== "object" || output === null) {
      return {};
    }
    const receipt = output as Record<string, unknown>;
    const tools = Array.isArray(receipt.tools) ? receipt.tools : [];
    return {
      dependencyCacheDigest: receipt.dependencyCacheDigest,
      imageConfiguration: receipt.imageConfiguration,
      pnpm: tools.find(
        (tool) =>
          typeof tool === "object" && tool !== null && "command" in tool && tool.command === "pnpm",
      ),
      toolchainReady: receipt.toolchainReady,
    };
  }
  return {};
};

export default defineEval({
  description:
    "The Eve agent reports the current Vercel development Sandbox and prepared toolchain without mutating it.",
  tags: ["sandbox-toolchain", "sandbox-integration"],
  async test(t) {
    await t.send("Inspect the sandbox toolchain.");
    t.succeeded();
    t.calledTool("inspect_sandbox_toolchain", { count: 1 });
    t.check(t.reply, includes("Sandbox toolchain receipt"));
    t.check(t.reply, includes('"backend":"vercel-development"'));
    t.check(t.reply, includes('"backendBlockers":[]'));
    t.eventsSatisfy("current required tool commands executed successfully", (events) =>
      events.some((event) => {
        if (event.type !== "action.result" || event.data.result.kind !== "tool-result") {
          return false;
        }
        if (event.data.result.toolName !== "inspect_sandbox_toolchain") {
          return false;
        }
        const { output } = event.data.result;
        if (typeof output !== "object" || output === null || !("tools" in output)) {
          return false;
        }
        const { tools } = output;
        if (!Array.isArray(tools)) {
          return false;
        }
        return requiredCommands.every((command) =>
          tools.some(
            (tool) =>
              typeof tool === "object" &&
              tool !== null &&
              "command" in tool &&
              tool.command === command &&
              "available" in tool &&
              tool.available === true &&
              "version" in tool &&
              typeof tool.version === "string" &&
              tool.version.length > 0,
          ),
        );
      }),
    );
    t.check(t.reply, includes("toolchainReady"));
    t.check(t.reply, includes("backend"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    process.stdout.write(
      `${JSON.stringify({ diagnostics: toolchainDiagnostics(t.events), version: 1 })}\n`,
    );
  },
});
