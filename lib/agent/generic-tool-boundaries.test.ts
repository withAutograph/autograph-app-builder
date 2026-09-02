import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("generic sandbox tool boundaries", () => {
  it.each(["agent", "bash", "read_file", "write_file"])(
    "keeps %s unavailable",
    async (tool) => {
      const source = await readFile(
        resolve(process.cwd(), `agent/tools/${tool}.ts`),
        "utf8",
      );

      expect(source).toContain('import { disableTool } from "eve/tools";');
      expect(source).toContain("export default disableTool();");
    },
  );

  it("routes existing application reads through the manifest-bound inspector", async () => {
    const [router, inspector] = await Promise.all([
      readFile(
        resolve(process.cwd(), "agent/tools/inspect_repository.ts"),
        "utf8",
      ),
      readFile(
        resolve(process.cwd(), "agent/tools/inspect_existing_app.ts"),
        "utf8",
      ),
    ]);

    expect(router).toContain("inspect_existing_app");
    expect(router).not.toContain("and read_file respectively");
    expect(inspector).toContain("inspectSourceBoundSandboxWorkspace");
    expect(inspector).toContain("githubSource: state.githubSource");
    expect(
      inspector.indexOf("inspectSourceBoundSandboxWorkspace"),
    ).toBeLessThan(inspector.indexOf(".app-builder/source-files.json"));
  });

  it("prepares the configured development source when a model inspects its sandbox path", async () => {
    const router = await readFile(
      resolve(process.cwd(), "agent/tools/inspect_repository.ts"),
      "utf8",
    );

    expect(router).toContain('const developmentWorkspacePath = "/workspace/repository"');
    expect(router).toContain("canAutoSelectDevelopmentSource()");
    expect(router).toContain("prepareDevelopmentSandboxWorkspace(");
    expect(router).toContain('"planning",');
    expect(router).toContain("sourceWorkflowState.update");
  });
});
