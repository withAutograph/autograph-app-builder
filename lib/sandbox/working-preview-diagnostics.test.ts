import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { describe, expect, it } from "vitest";

import {
  workingPreviewDiagnosticCollectorSource,
  workingPreviewDiagnosticExcerpt,
} from "./working-preview-diagnostics";

describe("working preview diagnostics", () => {
  it("keeps bounded independent tails in a private file while the server runs", async () => {
    const directory = await mkdtemp(nodePath.join(tmpdir(), "preview-diagnostics-"));
    try {
      const diagnosticsPath = nodePath.join(directory, "output.json");
      const source = `${workingPreviewDiagnosticCollectorSource}\nconst launch = ${JSON.stringify({ diagnosticsPath })};\nexport { appendPreviewDiagnostic };`;
      const collector = await import(
        `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
      );
      collector.appendPreviewDiagnostic("stdout", "a".repeat(20_000));
      collector.appendPreviewDiagnostic("stdout", "latest stdout");
      collector.appendPreviewDiagnostic("stderr", "Error: missing configuration");
      const output = JSON.parse(await readFile(diagnosticsPath, "utf-8"));
      expect(Buffer.byteLength(output.stdout)).toBe(4096);
      expect(output.stdout.endsWith("latest stdout")).toBe(true);
      expect(output.stderr).toBe("Error: missing configuration");
      const info = await stat(diagnosticsPath);
      expect(info.mode % 512).toBe(0o600);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([null, "invalid", "[]", "null", "x".repeat(65_537)])(
    "ignores malformed output %s",
    (input) => {
      expect(workingPreviewDiagnosticExcerpt(input)).toBe("");
    },
  );

  it("preserves actionable errors and stack context while removing common secrets", () => {
    const excerpt = workingPreviewDiagnosticExcerpt(
      JSON.stringify({
        stderr:
          '\u001B[31mError: failed DATABASE_PASSWORD="private value" TOKEN=hidden Bearer abc123 https://example.test/private?key=hidden eyJabc.def.ghi\n    at render (app/page.tsx:12:3)\u0000',
        stdout: "normal request body should not be included",
      }),
    );
    expect(excerpt).toContain("Error: failed");
    expect(excerpt).toContain("at render (app/page.tsx:12:3)");
    for (const secret of [
      "private value",
      "hidden",
      "abc123",
      "example.test",
      "eyJabc",
      "request body",
    ]) {
      expect(excerpt).not.toContain(secret);
    }
  });
});

it("redacts camel-case, hyphenated and underscored API keys and passwd", () => {
  const excerpt = workingPreviewDiagnosticExcerpt(
    JSON.stringify({
      stderr: "Error: connection failed apiKey=alpha api-key=beta api_key=gamma passwd=delta",
    }),
  );
  expect(excerpt).toContain("Error: connection failed");
  for (const secret of ["alpha", "beta", "gamma", "delta"]) {
    expect(excerpt).not.toContain(secret);
  }
});

it("retains a sanitized message-only listener error", () => {
  const result = workingPreviewDiagnosticExcerpt(
    JSON.stringify({
      message: "Error: listen EADDRINUSE 0.0.0.0:3001 https://preview.example/?token=secret-value",
      stderr: "",
    }),
  );
  expect(result).toContain("EADDRINUSE 0.0.0.0:3001");
  expect(result).not.toContain("secret-value");
});
