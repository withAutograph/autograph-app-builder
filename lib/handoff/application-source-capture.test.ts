/* oxlint-disable eslint/require-await -- Controlled async Sandbox ports preserve the real provider interface. */
import { describe, expect, it, vi } from "vitest";
import { captureApplicationSource } from "./application-source-capture";

const fixture = () => {
  const binary = Buffer.from([0, 255, 128, 1]);
  const rows = [
    { path: "apps/app/public/image.bin", kind: "file", mode: "100644", bytes: binary.length },
    { path: "apps/app/schema/release/old/sql.sql", kind: "file", mode: "100644", bytes: 2 },
    { path: "apps/app/.env.local", kind: "file", mode: "100644", bytes: 999 },
    { path: "apps/app/link", kind: "symlink" },
  ];
  const readBinaryFile = vi.fn(async ({ path }: { path: string }) =>
    path.endsWith("image.bin") ? binary : Buffer.from("ok"),
  );
  const run = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(rows), stderr: "" }));
  return {
    sandbox: { run, readBinaryFile },
    signal: new AbortController().signal,
    appId: "app",
    displayName: "App",
    sourceSessionId: "actual-owner",
    assertCurrent: vi.fn(async () => {}),
    rows,
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
