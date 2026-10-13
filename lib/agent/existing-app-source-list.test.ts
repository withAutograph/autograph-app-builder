import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  buildSourceInspectionOutput,
  listCurrentAppSourcePaths,
} from "../../agent/tools/inspect_existing_app";
import { EVE_MAX_PAYLOAD_BYTES, serializedPayloadBytes } from "../eve/payload-envelope";

const digest = (content: string) => createHash("sha256").update(content, "utf-8").digest("hex");
const resultEvent = (output: Awaited<ReturnType<typeof buildSourceInspectionOutput>>) => ({
  data: { result: { kind: "tool-result", output, toolName: "inspect_existing_app" } },
  type: "action.result",
});
const appPaths = Array.from(
  { length: 700 },
  (_, index) => `apps/spend-review/source-${index.toString().padStart(4, "0")}.ts`,
);

describe("existing app source listing", () => {
  it("re-reads tracked and newly added app files from the live checkout", async () => {
    const run = vi.fn(
      async (_input: { command: string }) =>
        await Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout:
            "apps/spend-review/app/page.tsx\0apps/spend-review/server/new-request.ts\0apps/other/app/page.tsx\0",
        }),
    );
    await expect(listCurrentAppSourcePaths({ run }, "spend-review")).resolves.toEqual([
      "apps/spend-review/app/page.tsx",
      "apps/spend-review/server/new-request.ts",
    ]);
    expect(run.mock.calls[0]?.[0].command).toContain(
      "ls-files -z --cached --others --exclude-standard -- 'apps/spend-review/'",
    );
  });

  it("reports a checkout read failure with the repository operation", async () => {
    const run = vi.fn(
      async (_input: { command: string }) =>
        await Promise.resolve({
          exitCode: 128,
          stderr: "fatal: not a git repository",
          stdout: "",
        }),
    );
    await expect(listCurrentAppSourcePaths({ run }, "spend-review")).rejects.toThrow(
      "Could not list current spend-review source files: fatal: not a git repository",
    );
  });

  it("preserves complete listing diagnostics while redacting credentials", async () => {
    const detail = `${"git listing detail ".repeat(100)} token=github_pat_12345678901234567890`;
    const run = vi.fn(
      async () => await Promise.resolve({ exitCode: 128, stderr: detail, stdout: "" }),
    );
    const failure = listCurrentAppSourcePaths({ run }, "spend-review");

    await expect(failure).rejects.toThrow("token=[REDACTED]");
    await expect(failure).rejects.toThrow("git listing detail ".repeat(100));
  });

  it("returns every app-owned source path above the previous 512-file ceiling", async () => {
    const paths = Array.from(
      { length: 700 },
      (_, index) => `apps/spend-review/source-${index.toString().padStart(4, "0")}.ts`,
    );
    const run = vi.fn(
      async (_input: { command: string }) =>
        await Promise.resolve({ exitCode: 0, stderr: "", stdout: `${paths.join("\0")}\0` }),
    );
    await expect(listCurrentAppSourcePaths({ run }, "spend-review")).resolves.toHaveLength(700);
  });
});

describe("existing app source content delivery", () => {
  it("keeps complete no-content discovery and its path cursor without a total file cap", async () => {
    const readTextFile = vi.fn(async () => await Promise.resolve(null));
    const overview = await buildSourceInspectionOutput({
      appId: "spend-review",
      availablePaths: appPaths,
      pathIndex: 0,
      paths: [],
      sandbox: { readTextFile },
    });
    expect(overview.availablePaths).toEqual(appPaths);
    expect(overview.files).toEqual([]);
    expect(overview.nextPathIndex).toBeUndefined();
    expect(readTextFile).not.toHaveBeenCalled();
    const continued = await buildSourceInspectionOutput({
      appId: "spend-review",
      availablePaths: appPaths,
      pathIndex: 512,
      paths: [],
      sandbox: { readTextFile },
    });
    expect(continued.availablePaths).toEqual(appPaths.slice(512));
  });

  it("retains envelope-limited index paging without losing paths", async () => {
    const paths = [0, 1, 2].map(
      (index) => `apps/spend-review/${index}-${"x".repeat(Math.floor(EVE_MAX_PAYLOAD_BYTES / 2))}`,
    );
    let pathIndex = 0;
    const collected: string[] = [];
    do {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each page uses the preceding authoritative cursor.
      const output = await buildSourceInspectionOutput({
        appId: "spend-review",
        availablePaths: paths,
        pathIndex,
        paths: [],
        sandbox: { readTextFile: async () => await Promise.resolve(null) },
      });
      expect(serializedPayloadBytes(resultEvent(output))).toBeLessThanOrEqual(
        EVE_MAX_PAYLOAD_BYTES,
      );
      collected.push(...(output.availablePaths ?? []));
      pathIndex = output.nextPathIndex ?? paths.length;
    } while (pathIndex < paths.length);
    expect(collected).toEqual(paths);
  });

  it("omits the redundant index while returning exact requested content and a compact discovery hint", async () => {
    const path = "apps/spend-review/README.md";
    const content = "Readable authored source.\n".repeat(200);
    const readTextFile = vi.fn(async () => await Promise.resolve(content));
    const output = await buildSourceInspectionOutput({
      appId: "spend-review",
      availablePaths: appPaths,
      pathIndex: 0,
      paths: [path],
      sandbox: { readTextFile },
    });
    expect(output).not.toHaveProperty("availablePaths");
    expect(output).not.toHaveProperty("nextPathIndex");
    expect(output.availablePathCount).toBe(700);
    expect(output.pathListing).toContain("without paths or contentPath");
    expect(output.files).toEqual([{ content, digest: digest(content), offsetBytes: 0, path }]);
    expect(readTextFile).toHaveBeenCalledExactlyOnceWith({ path: `repository/${path}` });
    const priorOutput = { appId: output.appId, availablePaths: appPaths, files: output.files };
    const priorBytes = serializedPayloadBytes(resultEvent(priorOutput));
    const contentBytes = serializedPayloadBytes(resultEvent(output));
    expect(priorBytes - contentBytes).toBeGreaterThan(15_000);
    console.info({
      contentResponseBytes: contentBytes,
      indexedResponseBytes: priorBytes,
      savedBytes: priorBytes - contentBytes,
    });
  });

  it("preserves raw UTF-8 bytes, full-file digest and continuation without index echo", async () => {
    const path = "apps/spend-review/large.txt";
    const content = 'α\\"\n'.repeat(1_800_000);
    const readTextFile = vi.fn(async () => await Promise.resolve(content));
    const first = await buildSourceInspectionOutput({
      appId: "spend-review",
      availablePaths: appPaths,
      pathIndex: 0,
      paths: [path],
      sandbox: { readTextFile },
    });
    expect(first.continuation).toBeDefined();
    expect(first).not.toHaveProperty("availablePaths");
    const { continuation } = first;
    if (continuation === undefined) {
      throw new Error("Expected a source continuation");
    }
    const last = await buildSourceInspectionOutput({
      appId: "spend-review",
      availablePaths: appPaths,
      contentPath: path,
      expectedDigest: continuation.digest,
      offsetBytes: continuation.offsetBytes,
      pathIndex: 0,
      paths: [path],
      sandbox: { readTextFile },
    });
    expect(last).not.toHaveProperty("availablePaths");
    expect(last.continuation).toBeUndefined();
    expect(first.files[0]?.content + (last.files[0]?.content ?? "")).toBe(content);
    expect(last.files[0]?.offsetBytes).toBe(Buffer.byteLength(first.files[0]?.content ?? ""));
    expect(first.files[0]?.digest).toBe(digest(content));
    expect(last.files[0]?.digest).toBe(digest(content));
    expect(serializedPayloadBytes(resultEvent(first))).toBeLessThanOrEqual(EVE_MAX_PAYLOAD_BYTES);
    expect(serializedPayloadBytes(resultEvent(last))).toBeLessThanOrEqual(EVE_MAX_PAYLOAD_BYTES);
  });

  it("retains changed-content detection on a digest-bound continuation", async () => {
    await expect(
      buildSourceInspectionOutput({
        appId: "spend-review",
        availablePaths: appPaths,
        contentPath: appPaths[0],
        expectedDigest: digest("earlier content"),
        offsetBytes: 1,
        pathIndex: 0,
        paths: [appPaths[0] ?? ""],
        sandbox: { readTextFile: async () => await Promise.resolve("changed content") },
      }),
    ).rejects.toThrow("changed during review");
  });

  it("reports missing requested files without substituting an index or another file", async () => {
    const path = "apps/spend-review/removed.ts";
    const output = await buildSourceInspectionOutput({
      appId: "spend-review",
      availablePaths: appPaths,
      pathIndex: 0,
      paths: [path],
      sandbox: { readTextFile: async () => await Promise.resolve(null) },
    });
    expect(output.files).toEqual([]);
    expect(output.missingPaths).toEqual([path]);
    expect(output.availablePathCount).toBe(700);
    expect(output).not.toHaveProperty("availablePaths");
  });
});
