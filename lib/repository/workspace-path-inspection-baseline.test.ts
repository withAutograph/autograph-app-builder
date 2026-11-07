/* oxlint-disable anti-slop/no-module-mocking -- Isolate the independently verified baseline authorization port to test canonical versus alias path projection, without fabricating a native receipt. */
import { expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import type { AppBaselineSelection } from "./app-baseline";
import { inspectWorkspacePath } from "./workspace-path-inspection";

vi.mock("./app-baseline", () => ({
  readableAppBaselinePaths: async (
    _sandbox: Pick<SandboxSession, "readTextFile">,
    _selection: AppBaselineSelection | undefined,
    paths: string[],
  ) =>
    paths.filter(
      (candidate) => !candidate.startsWith("/workspace/repository/app/schema/release/hidden"),
    ),
}));
it("retains canonical baseline archive omissions when a directory is addressed through an inside-root alias", async () => {
  const path = "/workspace/repository/schema-alias";
  const sandbox = {
    readTextFile: vi.fn().mockResolvedValue(null),
    run: vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        entries: [
          { kind: "directory", path: `${path}/visible` },
          { kind: "directory", path: `${path}/hidden` },
        ],
        kind: "workspace-directory",
        path,
        resolvedPath: "/workspace/repository/app/schema/release",
      }),
    })),
  };
  const result = await inspectWorkspacePath({
    baseline: undefined,
    metadata: { callId: "read", toolName: "inspect_repository", turnId: "turn" },
    path,
    sandbox,
  });
  expect(result).toMatchObject({
    entries: [{ kind: "directory", path: `${path}/visible` }],
    kind: "workspace-directory",
  });
  expect(result).not.toHaveProperty("resolvedPath");
});
