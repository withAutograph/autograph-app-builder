import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("generic sandbox tool boundaries", () => {
  it.each(["agent", "bash", "read-file", "write-file"])("keeps %s unavailable", async (tool) => {
    const source = await readFile(
      path.resolve(process.cwd(), `agent/tools/${tool.replaceAll("-", "_")}.ts`),
      "utf-8",
    );

    expect(source).toContain('import { disableTool } from "eve/tools";');
    expect(source).toContain("export default disableTool();");
  });

  it("keeps repository inspection separate from existing-application reads", async () => {
    const [router, inspector] = await Promise.all([
      readFile(path.resolve(process.cwd(), "agent/tools/inspect_repository.ts"), "utf-8"),
      readFile(path.resolve(process.cwd(), "agent/tools/inspect_existing_app.ts"), "utf-8"),
    ]);

    expect(router).not.toContain("inspect-existing-app");
    expect(router).not.toContain("and read-file respectively");
    expect(inspector).toContain("await ctx.getSandbox()");
    expect(inspector).not.toContain("inspectSourceBoundSandboxWorkspace");
    expect(inspector).toContain(`path: \`repository/\${path}\``);
    expect(inspector).not.toContain("allowed.has(path)");
  });

  it("prepares the configured development source when a model inspects its sandbox path", async () => {
    const router = await readFile(
      path.resolve(process.cwd(), "agent/tools/inspect_repository.ts"),
      "utf-8",
    );

    expect(router).toContain('const developmentWorkspacePath = "/workspace/repository"');
    expect(router).toContain("canAutoSelectDevelopmentSource()");
    expect(router).toContain("prepareDevelopmentSandboxWorkspace(");
    expect(router).toContain('"planning",');
    expect(router).toContain("sourceWorkflowState.update");
    expect(router).toContain("await ctx.getSandbox()");
    expect(router).toContain("const sandboxOverviewPaths");
    expect(router).toContain(`path: \`repository/\${overviewPath}\``);
  });
});
