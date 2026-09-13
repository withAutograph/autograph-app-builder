import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  candidateExportFromEvidence,
  candidateExportProvenanceFromEvidence,
  evidenceCompletion,
  evidencePrefix,
  evidenceSink,
} from "./self-reproduction-evidence";

const directories: string[] = [];

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function capture() {
  const directory = mkdtempSync(path.join(tmpdir(), "self-reproduction-evidence-"));
  directories.push(directory);
  const logPath = path.join(directory, "native.log");
  const transcriptPath = path.join(directory, "transcript.jsonl");
  const records: Record<string, unknown>[] = [];
  return { logPath, records, sink: evidenceSink(logPath, transcriptPath, records), transcriptPath };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function receipt(record: unknown) {
  return `${evidencePrefix}${JSON.stringify(record)}\n`;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("self-reproduction evidence completion", () => {
  it("fails an empty successful process instead of presenting missing output as success", () => {
    expect(evidenceCompletion(0, [])).toMatchObject({ status: "failed" });
  });

  it("requires a completion receipt after transcript events", () => {
    expect(evidenceCompletion(0, [{ kind: "event", text: "Still working" }])).toMatchObject({
      reason: expect.stringContaining("completion receipt"),
      status: "failed",
    });
  });

  it("requires transcript or tool events even when a completion receipt exists", () => {
    expect(evidenceCompletion(0, [{ kind: "eval-completed" }])).toMatchObject({
      reason: expect.stringContaining("transcript/tool events"),
      status: "failed",
    });
  });

  it.each([1, 137, null])("retains failure for exit %s despite complete receipts", (exitCode) => {
    const records = [{ kind: "event" }, { kind: "eval-completed" }];
    expect(evidenceCompletion(exitCode, records)).toMatchObject({ status: "failed" });
    expect(records).toEqual([{ kind: "event" }, { kind: "eval-completed" }]);
  });

  it("accepts a successful process with events and a completion receipt", () => {
    expect(evidenceCompletion(0, [{ kind: "event" }, { kind: "eval-completed" }])).toEqual({
      status: "completed",
    });
  });
});

describe("self-reproduction evidence persistence", () => {
  it("sanitizes credentials split across stream chunks before writing either artifact", () => {
    const { sink, logPath, transcriptPath, records } = capture();
    const raw = receipt({
      authorization: "Bearer private-bearer-value",
      continuationToken: "private-continuation-value",
      kind: "event",
      message: "API_KEY=private-key-value https://example.test/?token=private-query-value",
      nested: { password: "private-password-value" },
    });
    // Every credential, field name, and record prefix crosses a chunk boundary.
    for (const character of raw) sink.write(character);
    sink.end();

    for (const artifactPath of [logPath, transcriptPath]) {
      const persisted = readFileSync(artifactPath, "utf-8");
      for (const secret of [
        "private-bearer-value",
        "private-continuation-value",
        "private-key-value",
        "private-query-value",
        "private-password-value",
      ])
        expect(persisted).not.toContain(secret);
      expect(persisted).toContain("[REDACTED]");
    }
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      authorization: "[REDACTED]",
      continuationToken: "[REDACTED]",
      nested: { password: "[REDACTED]" },
    });
  });

  it("preserves ordinary token and cookie source identifiers in exported code", () => {
    const { sink, records } = capture();
    sink.write(
      receipt({
        kind: "event",
        event: {
          type: "action.result",
          data: {
            result: {
              toolName: "change_set_status",
              output: {
                exportFiles: [
                  {
                    path: "apps/replica/app/actions.ts",
                    content:
                      'const token = randomUUID(); const sessionCookie = "session"; API_KEY=private-value',
                  },
                ],
              },
            },
          },
        },
      }),
    );
    sink.end();
    const [file] = candidateExportFromEvidence(records) ?? [];
    expect(file?.content).toContain("const token = randomUUID()");
    expect(file?.content).toContain('sessionCookie = "session"');
    expect(file?.content).not.toContain("private-value");
  });

  it("extracts only a valid reviewed candidate source export", () => {
    expect(
      candidateExportFromEvidence([
        { event: { data: { toolName: "other" }, type: "action.result" }, kind: "event" },
        {
          event: {
            data: {
              result: {
                output: {
                  exportFiles: [
                    { content: "{}\n", path: "apps/replica/package.json" },
                    {
                      content: "export default function Page() {}\n",
                      path: "apps/replica/app/page.tsx",
                    },
                  ],
                },
                toolName: "change-set-status",
              },
            },
            type: "action.result",
          },
          kind: "event",
        },
      ]),
    ).toEqual([
      { content: "export default function Page() {}\n", path: "apps/replica/app/page.tsx" },
      { content: "{}\n", path: "apps/replica/package.json" },
    ]);
    expect(
      candidateExportFromEvidence([
        {
          event: {
            data: {
              result: {
                output: { exportFiles: [{ content: "leak", path: "../reference" }] },
                toolName: "change-set-status",
              },
            },
            type: "action.result",
          },
          kind: "event",
        },
      ]),
    ).toBeUndefined();
  });

  it("labels validation-failed exports as unreviewed evidence", () => {
    expect(
      candidateExportProvenanceFromEvidence([
        {
          event: {
            data: {
              result: {
                output: {
                  exportFiles: [{ content: "failed", path: "apps/replica/app/page.tsx" }],
                  status: "validation_failed",
                },
                toolName: "change-set-status",
              },
            },
            type: "action.result",
          },
        },
      ]),
    ).toBe("native unreviewed validation-failed export");
  });

  it("extracts the generated application root without target build artifacts", () => {
    expect(
      candidateExportFromEvidence([
        {
          event: {
            data: {
              result: {
                output: {
                  exportFiles: [
                    { content: "# Replica", path: "prototype/replica/app-spec.md" },
                    { content: "export default {}", path: "apps/replica/next.config.ts" },
                    { content: "export default null", path: "apps/replica/app/page.tsx" },
                  ],
                },
                toolName: "change-set-status",
              },
            },
            type: "action.result",
          },
        },
      ]),
    ).toEqual([
      { content: "export default null", path: "app/page.tsx" },
      { content: "export default {}", path: "next.config.ts" },
    ]);
  });

  it("flushes partial runs and preserves successful and failed tool outcomes in order", () => {
    const { sink, logPath, transcriptPath, records } = capture();
    const outcomes = [
      {
        kind: "event",
        output: { path: "app/page.tsx", status: "ok" },
        toolName: "read-file",
        type: "tool-result",
      },
      {
        error: "Typecheck failed",
        exitCode: 2,
        kind: "event",
        toolName: "validate_app",
        type: "tool-error",
      },
    ];
    sink.write(`Native eval started\n${receipt(outcomes[0])}${receipt(outcomes[1]).trimEnd()}`);
    sink.end();
    sink.end();

    expect(records).toEqual(outcomes);
    expect(
      readFileSync(transcriptPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(outcomes);
    expect(readFileSync(logPath, "utf-8")).toContain("Native eval started");
    expect(evidenceCompletion(null, records)).toMatchObject({ status: "failed" });
  });

  it("keeps malformed and truncated records in diagnostics without inventing completion", () => {
    const { sink, logPath, records } = capture();
    sink.write(receipt({ kind: "event", text: "Candidate work began" }));
    sink.write(`${evidencePrefix}{not json}\n`);
    sink.write(`${evidencePrefix}{"kind":"eval-completed"`);
    sink.end();

    expect(records).toEqual([{ kind: "event", text: "Candidate work began" }]);
    expect(readFileSync(logPath, "utf-8")).toContain("{not json}");
    expect(readFileSync(logPath, "utf-8")).toContain('{"kind":"eval-completed"');
    expect(evidenceCompletion(0, records)).toMatchObject({ status: "failed" });
  });

  it("ignores JSON values that are not evidence record objects", () => {
    const { sink, logPath, records } = capture();
    for (const malformed of [null, false, 42, "eval-completed", [], [{ kind: "eval-completed" }]]) {
      sink.write(receipt(malformed));
    }
    sink.end();

    expect(records).toEqual([]);
    expect(readFileSync(logPath, "utf-8")).toContain(`${evidencePrefix}null`);
    expect(evidenceCompletion(0, records)).toMatchObject({ status: "failed" });
  });
});
