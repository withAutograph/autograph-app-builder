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
    appRoot: "apps/invoice-app",
    importedByCallId: "import-call",
    importedSessionId: "hosted-session",
    kind: "application-source-import-v1" as const,
    platformSourceReceiptDigest: "b".repeat(64),
    reference: {
      appId: "invoice-app",
      kind: "application-source-candidate-v1" as const,
      manifestDigest: "a".repeat(64),
      uploadId: "46024567-225f-4169-9b78-2b2e19ba8848",
    },
    sourceSessionId: "local-session",
    version: 1 as const,
    workspaceId: "private-workspace",
  };
  const bytes = Buffer.from([0, 255, 10, 13]);
  const files = [
    {
      bytes: bytes.length,
      mode: "100755",
      path: "apps/invoice-app/public/data.bin",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ];
  writeFileSync(path.join(staging, "0.base64"), bytes.toString("base64"));
  const plan = { files, receipt, staging };
  writeFileSync(path.join(staging, "plan.json"), JSON.stringify(plan));
  const script = path.join(staging, "import.cjs");
  writeFileSync(script, applicationSourceImportProgram({ ...plan, root }));
  const run = () => spawnSync(process.execPath, [script], { encoding: "utf-8" });
  return { bytes, files, receipt, root, run, staging };
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
      files: f.files,
      receipt: { ...f.receipt, importedSessionId: "foreign" },
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
    files: [{ contentBase64: f.bytes.toString("base64"), path: f.files[0]?.path }],
    manifest: {
      appId: receipt.reference.appId,
      displayName: "Invoice App",
      files: f.files,
      kind: "application-source-v1",
      omissions: [],
      sourceSessionId: receipt.sourceSessionId,
      version: 1,
    },
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    materializeApplicationSource({ abortSignal: controller.signal, receipt, sandbox, validated }),
  ).rejects.toThrow();
  await expect(
    materializeApplicationSource({
      assertCurrent: async () => {
        await Promise.resolve();
        throw new Error("Owner changed");
      },
      receipt,
      sandbox,
      validated,
    }),
  ).rejects.toThrow("Owner changed");
  expect(run).not.toHaveBeenCalled();
});
