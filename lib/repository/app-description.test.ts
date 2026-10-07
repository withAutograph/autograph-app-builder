import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appDescriptionSourceInspectionProgram, describeSelectedApp } from "./app-description";

const descriptor = {
  app: { id: "spend-review", routes: ["/spend-review"], workspacePath: "apps/spend-review" },
  backend: {
    authorization: "app-owned",
    kind: "generated-postgres",
    release: { artifactHash: "sha256:hash", directory: "release/v12", id: "v12" },
    roles: [],
    runtime: { databaseEnvironment: "SPEND_REVIEW_DATABASE_URL" },
  },
  validation: { browser: null, check: { task: "check" }, test: { shards: 1, task: "test" } },
  version: 1,
};
const runDescription = async (exitCode: number, stdout: string, stderr = "") =>
  await describeSelectedApp({
    appId: "spend-review",
    root: "/workspace/repository",
    sandbox: { run: vi.fn().mockResolvedValue({ exitCode, stderr, stdout }) },
  });

describe("repository app description", () => {
  it("accepts the repository's absent optional authenticated schema receipt without inventing proof", async () => {
    const result = await runDescription(0, JSON.stringify(descriptor));
    expect(result.backend).toMatchObject({ kind: "generated-postgres", schemaReceipt: null });
  });
  it("retains exit status and repository diagnostic while redacting credentials", async () => {
    await expect(
      runDescription(
        1,
        "",
        // Synthetic diagnostic deliberately exercises secret redaction.
        // oxlint-disable-next-line sonarjs/no-hardcoded-passwords
        "Missing release; password=secret-value Bearer abc postgres://owner:secret@host/db",
      ),
    ).rejects.toThrow(
      "app:describe exited 1). Repair its app:describe command and retry. Cause: Missing release; password=[REDACTED] Bearer [REDACTED] [URL REDACTED]",
    );
  });
  it("uses stdout for a failed command without stderr", async () => {
    await expect(runDescription(7, "Application spend-review is not registered")).rejects.toThrow(
      "Cause: Application spend-review is not registered",
    );
  });
  it("reports when the repository command supplied no diagnostic", async () => {
    await expect(runDescription(2, "")).rejects.toThrow(
      "Cause: The command returned no diagnostic output.",
    );
  });
  it("continues to reject malformed receipt claims", async () => {
    await expect(
      runDescription(
        0,
        JSON.stringify({
          ...descriptor,
          backend: {
            ...descriptor.backend,
            schemaReceipt: { contract: "unverified", path: "/schema" },
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("app description source diagnostics", () => {
  it("adds allowlisted source facts to a failed descriptor without exposing source content", async () => {
    const facts = {
      baselinePlatformHead: "b".repeat(40),
      configOverridePresent: true,
      configuration: [{ path: ".config/mise/config.toml", state: "absent" }],
      descriptionScriptExists: false,
      sourceHead: "a".repeat(40),
      workingDirectoryMatchesRoot: false,
    };
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stderr: "no task //:app:describe found", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: JSON.stringify(facts) });
    await expect(
      describeSelectedApp({
        appId: "spend-review",
        root: "/workspace/repository",
        sandbox: { run },
      }),
    ).rejects.toThrow(`Source inspection: ${JSON.stringify(facts)}`);
    expect(run).toHaveBeenLastCalledWith({
      command: `node -e '${appDescriptionSourceInspectionProgram}' spend-review '/workspace/repository' '/workspace/.app-builder/app-baselines/spend-review.json'`,
      workingDirectory: "/workspace/repository",
    });
    expect(appDescriptionSourceInspectionProgram).not.toContain("process.env.MISE_CONFIG_FILE,");
  });
});

it("executes source inspection without printing config contents or override values", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "describe-source-facts-"));
  try {
    mkdirSync(path.join(root, ".config/mise"), { recursive: true });
    writeFileSync(
      path.join(root, ".config/mise/config.toml"),
      '[tasks."app:describe"]\nrun = "secret-synthetic-command"\n',
    );
    const child = path.join(root, "child");
    mkdirSync(child);
    const output = execFileSync(
      process.execPath,
      ["-e", appDescriptionSourceInspectionProgram, "spend-review", root],
      {
        cwd: child,
        encoding: "utf-8",
        env: { ...process.env, MISE_CONFIG_FILE: "synthetic-private-config" },
      },
    );
    expect(output).toContain('"state":"declared"');
    expect(output).toContain('"configOverridePresent":true');
    expect(output).toContain('"workingDirectoryMatchesRoot":false');
    expect(output).not.toContain("secret-synthetic-command");
    expect(output).not.toContain("synthetic-private-config");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
