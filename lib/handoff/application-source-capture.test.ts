/* oxlint-disable eslint/require-await -- Controlled async Sandbox ports preserve the real provider interface. */
import { describe, expect, it, vi } from "vitest";
import {
  captureApplicationSource,
  applicationSourceInventoryProgram,
} from "./application-source-capture";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";

const fixture = () => {
  const binary = Buffer.from([0, 255, 128, 1]);
  const rows = [
    { bytes: binary.length, kind: "file", mode: "100644", path: "apps/app/public/image.bin" },
    { bytes: 2, kind: "file", mode: "100644", path: "apps/app/schema/release/old/sql.sql" },
    { bytes: 999, kind: "file", mode: "100644", path: "apps/app/.env.local" },
    { kind: "symlink", path: "apps/app/link" },
  ];
  const readBinaryFile = vi.fn(async ({ path }: { path: string }) =>
    path.endsWith("image.bin") ? binary : Buffer.from("ok"),
  );
  const run = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify(rows) }));
  return {
    appId: "app",
    assertCurrent: vi.fn<() => Promise<void>>().mockResolvedValue(),
    displayName: "App",
    rows,
    sandbox: { readBinaryFile, run },
    signal: new AbortController().signal,
    sourceSessionId: "actual-owner",
  };
};
describe("capture current applied app source", () => {
  it("reads actual binary bytes and schema history while reporting secret and symlink omissions", async () => {
    const f = fixture();
    const result = await captureApplicationSource(f);
    expect(result.files.map((file) => file.path)).toEqual([
      "apps/app/public/image.bin",
      "apps/app/schema/release/old/sql.sql",
    ]);
    expect(result.files[0]?.bytes).toEqual(Buffer.from([0, 255, 128, 1]));
    expect(result.artifact.manifest.omissions).toEqual([
      { path: "apps/app/.env.local", reason: "credential" },
      { path: "apps/app/link", reason: "symlink" },
    ]);
    expect(f.sandbox.readBinaryFile.mock.calls.some(([file]) => file.path.includes(".env"))).toBe(
      false,
    );
  });
  it("refuses changed source rather than exporting an inconsistent snapshot", async () => {
    const f = fixture();
    let reads = 0;
    f.sandbox.readBinaryFile.mockImplementation(async () =>
      Buffer.from((reads += 1) < 3 ? [0, 255, 128, 1] : [4, 5, 6, 7]),
    );
    await expect(captureApplicationSource(f)).rejects.toThrow("changed during capture");
  });
  it("refuses cancelled or changed owner workflow before retaining anything", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(captureApplicationSource({ ...f, signal: abort.signal })).rejects.toThrow();
    expect(f.sandbox.run).not.toHaveBeenCalled();
    f.assertCurrent.mockRejectedValue(new Error("owner changed"));
    await expect(captureApplicationSource(f)).rejects.toThrow("owner changed");
  });
});

it("prunes actual Playwright reports and browser auth while retaining nested code and ZIP assets", async () => {
  const root = await mkdtemp(nodePath.join(tmpdir(), "app-source-retention-"));
  const files = {
    ".auth/member.json": '{"cookies":[{"value":"fixture-only"}]}',
    "app/test-results/page.tsx": "export default function Page() { return null; }",
    "blob-report/report.zip": Buffer.from([0, 255, 3]),
    "playwright-report/index.html": "request fixture_cookie=not-a-secret",
    "playwright/.auth/member.json": '{"origins":[{"localStorage":[]}]}',
    "public/archive.zip": Buffer.from([0, 255, 4]),
    "schema/release/old/sql.sql": "select 1;",
    "test-results/run/screenshot.png": Buffer.from([0, 255, 2]),
    "test-results/run/trace.zip": Buffer.from([0, 255, 1]),
  };
  const reads: string[] = [];
  try {
    for (const [relative, bytes] of Object.entries(files)) {
      const destination = nodePath.join(root, "apps/app", relative);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Construct each independent owned fixture file before capture begins.
      await mkdir(nodePath.join(destination, ".."), { recursive: true });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Fixture inventory must be complete before the actual scan executes.
      await writeFile(destination, bytes);
    }
    const result = await captureApplicationSource({
      appId: "app",
      assertCurrent: vi.fn<() => Promise<void>>().mockResolvedValue(),
      displayName: "App",
      sandbox: {
        readBinaryFile: async ({ path }) => {
          const relative = path.slice("/workspace/repository/apps/app/".length);
          reads.push(relative);
          return await readFile(nodePath.join(root, "apps/app", relative));
        },
        run: async () => {
          const stdout = execFileSync(
            "/usr/bin/python3",
            [
              "-c",
              applicationSourceInventoryProgram.replace(
                "root='/workspace/repository'",
                `root=${JSON.stringify(root)}`,
              ),
              "app",
            ],
            { encoding: "utf-8" },
          );
          return { exitCode: 0, stderr: "", stdout };
        },
      },
      signal: new AbortController().signal,
      sourceSessionId: "fixture-session",
    });
    expect(result.artifact.manifest.files.map((file) => file.path)).toEqual([
      "apps/app/app/test-results/page.tsx",
      "apps/app/public/archive.zip",
      "apps/app/schema/release/old/sql.sql",
    ]);
    expect(result.artifact.manifest.omissions).toEqual([
      { path: "apps/app/.auth", reason: "credential" },
      { path: "apps/app/blob-report", reason: "runtime-state" },
      { path: "apps/app/playwright-report", reason: "runtime-state" },
      { path: "apps/app/playwright/.auth", reason: "credential" },
      { path: "apps/app/test-results", reason: "runtime-state" },
    ]);
    expect(
      reads.every((relative) =>
        ["app/test-results/page.tsx", "public/archive.zip", "schema/release/old/sql.sql"].includes(
          relative,
        ),
      ),
    ).toBe(true);
    expect(result.files.find((file) => file.path.endsWith("archive.zip"))?.bytes).toEqual(
      Buffer.from([0, 255, 4]),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
