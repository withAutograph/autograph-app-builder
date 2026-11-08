import { validateApplicationSourceArtifact } from "../handoff/application-source-bytes";
import type { SandboxSession } from "eve/sandbox";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import {
  applicationSourceImportProgram,
  materializeApplicationSource,
} from "./application-source-import";

const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "builder-source-import-"));
  const staging = path.join(root, "stage");
  mkdirSync(staging);
  const receipt = {
    version: 1 as const,
    kind: "application-source-import-v1" as const,
    reference: {
      kind: "application-source-candidate-v1" as const,
      uploadId: "46024567-225f-4169-9b78-2b2e19ba8848",
      appId: "invoice-app",
      manifestDigest: "a".repeat(64),
    },
    sourceSessionId: "local-session",
    importedSessionId: "hosted-session",
    platformSourceReceiptDigest: "b".repeat(64),
    workspaceId: "private-workspace",
    appRoot: "apps/invoice-app",
    importedByCallId: "import-call",
  };
  const bytes = Buffer.from([0, 255, 10, 13]);
  const files = [
    {
      path: "apps/invoice-app/public/data.bin",
      mode: "100755",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ];
  writeFileSync(path.join(staging, "0.base64"), bytes.toString("base64"));
  const plan = { receipt, files, staging };
  writeFileSync(path.join(staging, "plan.json"), JSON.stringify(plan));
  const script = path.join(staging, "import.cjs");
  writeFileSync(script, applicationSourceImportProgram({ ...plan, root }));
  const run = () => spawnSync(process.execPath, [script], { encoding: "utf-8" });
  return { root, staging, receipt, files, bytes, run };
};
describe("source-only application materialization", () => {
  it("preserves binary bytes and mode without executing source, and resumes without overwriting edits", () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const file = path.join(f.root, f.files[0].path);
    expect(readFileSync(file)).toEqual(f.bytes);
    expect(statSync(file).mode.toString(8).slice(-3)).toBe("755");
    writeFileSync(file, "accepted later edit");
    expect(f.run().status).toBe(0);
    expect(readFileSync(file, "utf-8")).toBe("accepted later edit");
  });
  it("refuses occupied source and preserves its data", () => {
    const f = fixture();
    const app = path.join(f.root, f.receipt.appRoot);
    mkdirSync(app, { recursive: true });
    writeFileSync(path.join(app, "keep.txt"), "prior");
    expect(f.run().status).not.toBe(0);
    expect(readFileSync(path.join(app, "keep.txt"), "utf-8")).toBe("prior");
  });
  it("rejects tampered chunks and symlinked application parents", () => {
    const f = fixture();
    writeFileSync(path.join(f.staging, "0.base64"), Buffer.from("changed").toString("base64"));
    expect(f.run().status).not.toBe(0);
    const g = fixture();
    symlinkSync(g.staging, path.join(g.root, "apps"));
    expect(g.run().status).not.toBe(0);
  });
  it("rejects a changed import binding instead of adopting its old marker", () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const plan = {
      receipt: { ...f.receipt, importedSessionId: "foreign" },
      files: f.files,
      staging: f.staging,
    };
    writeFileSync(path.join(f.staging, "plan.json"), JSON.stringify(plan));
    expect(f.run().status).not.toBe(0);
  });
});

it("does not stage source after cancellation or owner rejection", async () => {
  const run = vi.fn<SandboxSession["run"]>();
  const sandbox = { run, writeTextFile: vi.fn<SandboxSession["writeTextFile"]>() };
  const f = fixture();
  const { receipt } = f;
  const validated = validateApplicationSourceArtifact({
    manifest: {
      version: 1,
      kind: "application-source-v1",
      appId: receipt.reference.appId,
      displayName: "Invoice App",
      sourceSessionId: receipt.sourceSessionId,
      files: f.files,
      omissions: [],
    },
    files: [{ path: f.files[0]?.path, contentBase64: f.bytes.toString("base64") }],
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    materializeApplicationSource({ sandbox, validated, receipt, abortSignal: controller.signal }),
  ).rejects.toThrow();
  await expect(
    materializeApplicationSource({
      sandbox,
      validated,
      receipt,
      assertCurrent: async () => {
        await Promise.resolve();
        throw new Error("Owner changed");
      },
    }),
  ).rejects.toThrow("Owner changed");
  expect(run).not.toHaveBeenCalled();
});
