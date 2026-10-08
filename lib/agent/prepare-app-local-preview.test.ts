import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { appDescriptionSchema } from "../repository/app-description";
import path from "node:path";
import { localRuntimeEnvironmentPath } from "../repository/runtime-environment";

import {
  appDeclaresLocalSetup,
  localPreviewExecutionCommand,
  localPreviewSetupCommand,
  prepareAppLocalPreview,
  prepareValidationLocalData,
} from "../../agent/tools/prepare-app-local-preview";

const descriptor = (backend: z.infer<typeof appDescriptionSchema>["backend"]) =>
  JSON.stringify({
    app: { id: "spend-review", routes: ["/spend-review"], workspacePath: "apps/spend-review" },
    backend,
    validation: { browser: null, check: { task: "check" }, test: { shards: 1, task: "test" } },
    version: 1,
  });
const generated: z.infer<typeof appDescriptionSchema>["backend"] = {
  authorization: "declared-policy",
  kind: "generated-postgres",
  release: { artifactHash: "hash", directory: "release", id: "v1" },
  roles: ["member"],
  runtime: { databaseEnvironment: "SPEND_REVIEW_DATABASE_URL" },
  schemaReceipt: null,
};
const generatedWithReviewer: z.infer<typeof appDescriptionSchema>["backend"] = {
  ...generated,
  roles: ["member", "reviewer"],
};
const runtimeStateDirectory = path.posix.dirname(
  localRuntimeEnvironmentPath("/workspace/repository", "spend-review"),
);
describe("private local preview setup", () => {
  it("discovers the source-derived backend rather than a demo setup declaration", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stderr: "", stdout: descriptor(generated) });
    const input = { appId: "spend-review", root: "/workspace/repository", sandbox: { run } };
    expect(await appDeclaresLocalSetup(input)).toBe(true);
    expect(run).toHaveBeenCalledWith({
      command: "mise run app:describe spend-review",
      workingDirectory: input.root,
    });
    run.mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor({ kind: "static" }) });
    expect(await appDeclaresLocalSetup(input)).toBe(false);
  });
  it("prepares authenticated data before validation and preserves setup failures", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor(generated) })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor(generated) })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "pg_ctl failed", stdout: "" });
    await expect(
      prepareValidationLocalData({
        appId: "spend-review",
        root: "/workspace/repository",
        sandbox: { run },
      }),
    ).rejects.toThrow(/Validation could not prepare.*pg_ctl failed/su);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenLastCalledWith({
      command: localPreviewExecutionCommand("spend-review"),
      env: {
        APP_RUNTIME_ROLES: "member",
        APP_RUNTIME_STATE_DIR: runtimeStateDirectory,
      },
      workingDirectory: "/workspace/repository",
    });
  });

  it("runs the selected app's repository task in its checkout", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor(generated) })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "Local setup complete" });
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(run).toHaveBeenCalledWith({
      command: localPreviewExecutionCommand("spend-review"),
      env: {
        APP_RUNTIME_ROLES: "member",
        APP_RUNTIME_STATE_DIR: runtimeStateDirectory,
      },
      workingDirectory: "/workspace/repository",
    });
    expect(localPreviewExecutionCommand("spend-review")).toContain(
      "mise run app:runtime prepare spend-review local",
    );
    expect(result).toMatchObject({ exitCode: 0, status: "prepared" });
    expect(() => localPreviewSetupCommand("spend-review; deploy")).toThrow();
  });

  it("passes accepted roles and the private auth origin through the runtime environment", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor(generatedWithReviewer) })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "Local setup complete" });
    await prepareAppLocalPreview({
      appId: "spend-review",
      authOrigin: "https://spend-review.vercel.run",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(run).toHaveBeenLastCalledWith({
      command: localPreviewExecutionCommand("spend-review"),
      env: {
        APP_RUNTIME_AUTH_ORIGIN: "https://spend-review.vercel.run",
        APP_RUNTIME_ROLES: "member,reviewer",
        APP_RUNTIME_STATE_DIR: runtimeStateDirectory,
      },
      workingDirectory: "/workspace/repository",
    });
  });

  it("preserves actionable local database failures without leaking connection strings", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor(generated) })
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr:
          "pg_ctl: could not start server at postgres://postgres:secret@127.0.0.1:52016/spend_review",
        stdout: "",
      });
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(result).toMatchObject({ exitCode: 1, status: "failed" });
    expect(result.problem).toContain("local database startup");
    expect(result.stderr).toContain("pg_ctl");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("reports command-provider errors with a recovery action", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor(generated) })
      .mockRejectedValueOnce(new Error("Sandbox unavailable: token=secret"));
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(result).toMatchObject({ exitCode: null, status: "failed" });
    expect(result.problem).toContain("sandbox command runner");
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });
});
