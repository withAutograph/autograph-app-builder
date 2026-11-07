import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applicationSourceManifestDigest,
  validateApplicationSourceArtifact,
} from "./application-source-bytes";

const entry = (path: string, bytes: Buffer) => ({
  bytes: bytes.length,
  mode: "100644" as const,
  path,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
const artifact = () => {
  const binary = Buffer.from([0, 255, 2, 128]);
  const code = Buffer.from("export default 1;");
  return {
    files: [
      { contentBase64: binary.toString("base64"), path: "apps/my-app/public/logo.bin" },
      { contentBase64: code.toString("base64"), path: "apps/my-app/schema/release/v1/code.ts" },
    ],
    manifest: {
      appId: "my-app",
      displayName: "My App",
      files: [
        entry("apps/my-app/public/logo.bin", binary),
        entry("apps/my-app/schema/release/v1/code.ts", code),
      ],
      kind: "application-source-v1" as const,
      omissions: [],
      sourceSessionId: "new-session",
      version: 1 as const,
    },
  };
};
describe("untrusted application source bytes", () => {
  it("preserves binary and historical app schema bytes with deterministic inventory digest", () => {
    const a = artifact();
    const result = validateApplicationSourceArtifact(a);
    expect(result.files.find((f) => f.path.endsWith("logo.bin"))?.bytes).toEqual(
      Buffer.from([0, 255, 2, 128]),
    );
    expect(
      applicationSourceManifestDigest({ ...a.manifest, files: a.manifest.files.toReversed() }),
    ).toBe(result.manifestDigest);
  });
  it("rejects byte corruption, duplicates and file inventory mismatch", () => {
    const a = artifact();
    a.files[0].contentBase64 = "AQ==";
    expect(() => validateApplicationSourceArtifact(a)).toThrow();
    const b = artifact();
    b.files.push(b.files[0]);
    expect(() => validateApplicationSourceArtifact(b)).toThrow();
    const c = artifact();
    c.files.pop();
    expect(() => validateApplicationSourceArtifact(c)).toThrow();
  });
  it("rejects case-colliding source destinations", () => {
    const a = artifact();
    const bytes = Buffer.from("x");
    a.manifest.files = [entry("apps/my-app/Logo.bin", bytes), entry("apps/my-app/logo.bin", bytes)];
    a.files = a.manifest.files.map((file) => ({
      contentBase64: bytes.toString("base64"),
      path: file.path,
    }));
    expect(() => validateApplicationSourceArtifact(a)).toThrow();
  });
  it.each([
    "../escape",
    "apps/other-app/code.ts",
    "apps/my-app/.env.local",
    "apps/my-app/node_modules/code.ts",
    "apps/my-app/.eve/journal.json",
    "apps/my-app/test-results/run/trace.zip",
    "apps/my-app/playwright-report/index.html",
    "apps/my-app/blob-report/report.zip",
    "apps/my-app/.auth/browser.json",
    "apps/my-app/playwright/.auth/browser.json",
    "apps/my-app/public/../secret",
  ])("rejects unsafe imported path %s", (path) => {
    const a = artifact();
    const bytes = Buffer.from("x");
    a.manifest.files = [entry(path, bytes)];
    a.files = [{ contentBase64: bytes.toString("base64"), path }];
    expect(() => validateApplicationSourceArtifact(a)).toThrow();
  });
});
