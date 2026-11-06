import { expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import type { AppBaselineSelection } from "./app-baseline";
import { inspectWorkspacePath } from "./workspace-path-inspection";

vi.mock("./app-baseline", () => ({
  readableAppBaselinePaths: (
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
    readTextFile: vi.fn(() => null),
    run: vi.fn(() => ({
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
    baseline: null,
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
