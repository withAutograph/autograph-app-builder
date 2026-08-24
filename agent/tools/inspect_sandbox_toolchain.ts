import { defineTool } from "eve/tools";
import { z } from "zod";

const commands = ["bash", "git", "mise", "bun", "node", "pnpm"] as const;

export default defineTool({
  description:
    "Inspect the fixed sandbox build-tool allowlist without installing packages or mutating the workspace.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    const tools = await Promise.all(
      commands.map(async (command) => {
        const location = await sandbox.run({
          command: `command -v ${command}`,
        });
        if (location.exitCode !== 0)
          return { command, available: false as const };
        const version = await sandbox.run({ command: `${command} --version` });
        return {
          command,
          available: true as const,
          path: location.stdout.trim(),
          version:
            (version.stdout.trim() || version.stderr.trim()).split("\n")[0] ??
            "",
        };
      }),
    );
    const available = new Set(
      tools.flatMap((tool) => (tool.available ? [tool.command] : [])),
    );
    return {
      sandboxId: sandbox.id,
      toolchainReady: (["git", "mise", "bun"] as const).every((command) =>
        available.has(command),
      ),
      tools,
    };
  },
});
