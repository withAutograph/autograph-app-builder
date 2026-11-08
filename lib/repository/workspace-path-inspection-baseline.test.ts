/* oxlint-disable anti-slop/no-module-mocking -- Isolate the independently verified baseline authorization port to test canonical versus alias path projection, without fabricating a native receipt. */
import { expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import type { AppBaselineSelection } from "./app-baseline";
import { inspectWorkspacePath } from "./workspace-path-inspection";

vi.mock("./app-baseline", () => ({
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
  readableAppBaselinePaths: (
    _sandbox: Pick<SandboxSession, "readTextFile">,
    _selection: AppBaselineSelection | undefined,
    paths: string[],
  ) =>
    Promise.resolve(
      paths.filter(
        (candidate) => !candidate.startsWith("/workspace/repository/app/schema/release/hidden"),
      ),
    ),
}));
it("retains canonical baseline archive omissions when a directory is addressed through an inside-root alias", async () => {
  const path = "/workspace/repository/schema-alias";
  const sandbox = {
    readTextFile: vi.fn<() => Promise<null>>().mockResolvedValue(null),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    run: vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          kind: "workspace-directory",
          path,
          resolvedPath: "/workspace/repository/app/schema/release",
          entries: [
            { path: `${path}/visible`, kind: "directory" },
            { path: `${path}/hidden`, kind: "directory" },
          ],
        }),
      }),
    ),
  };
  const result = await inspectWorkspacePath({
    path,
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    baseline: undefined,
    sandbox,
    metadata: { callId: "read", toolName: "inspect_repository", turnId: "turn" },
  });
  expect(result).toMatchObject({
    kind: "workspace-directory",
    entries: [{ path: `${path}/visible`, kind: "directory" }],
  });
  expect(result).not.toHaveProperty("resolvedPath");
});
