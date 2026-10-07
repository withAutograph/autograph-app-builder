import { describe, expect, it, vi } from "vitest";
import { describeSelectedApp } from "./app-description";

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
