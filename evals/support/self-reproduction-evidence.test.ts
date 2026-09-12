import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  candidateExportFromEvidence,
  candidateExportProvenanceFromEvidence,
  evidenceCompletion,
  evidencePrefix,
  evidenceSink,
} from "./self-reproduction-evidence";

const directories: string[] = [];

function capture() {
  const directory = mkdtempSync(join(tmpdir(), "self-reproduction-evidence-"));
  directories.push(directory);
  const logPath = join(directory, "native.log");
  const transcriptPath = join(directory, "transcript.jsonl");
  const records: Record<string, unknown>[] = [];
  return { logPath, transcriptPath, records, sink: evidenceSink(logPath, transcriptPath, records) };
}

function receipt(record: unknown) {
  return `${evidencePrefix}${JSON.stringify(record)}\n`;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("self-reproduction evidence completion", () => {
  it("fails an empty successful process instead of presenting missing output as success", () => {
    expect(evidenceCompletion(0, [])).toMatchObject({ status: "failed" });
  });

  it("requires a completion receipt after transcript events", () => {
    expect(evidenceCompletion(0, [{ kind: "event", text: "Still working" }])).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("completion receipt"),
    });
  });

  it("requires transcript or tool events even when a completion receipt exists", () => {
    expect(evidenceCompletion(0, [{ kind: "eval-completed" }])).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("transcript/tool events"),
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
      kind: "event",
      authorization: "Bearer private-bearer-value",
      continuationToken: "private-continuation-value",
      message: "API_KEY=private-key-value https://example.test/?token=private-query-value",
      nested: { password: "private-password-value" },
    });
    // Every credential, field name, and record prefix crosses a chunk boundary.
    for (const character of raw) sink.write(character);
    sink.end();

    for (const path of [logPath, transcriptPath]) {
      const persisted = readFileSync(path, "utf-8");
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

  it("extracts only a valid reviewed candidate source export", () => {
    expect(
      candidateExportFromEvidence([
        { kind: "event", event: { type: "action.result", data: { toolName: "other" } } },
        {
          kind: "event",
          event: {
            type: "action.result",
            data: {
              toolName: "change_set_status",
              result: {
                exportFiles: [
                  { path: "apps/replica/package.json", content: "{}\n" },
                  {
                    path: "apps/replica/app/page.tsx",
                    content: "export default function Page() {}\n",
                  },
                ],
              },
            },
          },
        },
      ]),
    ).toEqual([
      { path: "apps/replica/app/page.tsx", content: "export default function Page() {}\n" },
      { path: "apps/replica/package.json", content: "{}\n" },
    ]);
    expect(
      candidateExportFromEvidence([
        {
          kind: "event",
          event: {
            type: "action.result",
            data: {
              toolName: "change_set_status",
              result: { exportFiles: [{ path: "../reference", content: "leak" }] },
            },
          },
        },
      ]),
    ).toBeUndefined();
  });

  it("labels validation-failed exports as unreviewed evidence", () => {
    expect(
      candidateExportProvenanceFromEvidence([
        {
          event: {
            type: "action.result",
            data: {
              toolName: "change_set_status",
              result: {
                status: "validation_failed",
                exportFiles: [{ path: "apps/replica/app/page.tsx", content: "failed" }],
              },
            },
          },
        },
      ]),
    ).toBe("native unreviewed validation-failed export");
  });

  it("flushes partial runs and preserves successful and failed tool outcomes in order", () => {
    const { sink, logPath, transcriptPath, records } = capture();
    const outcomes = [
      {
        kind: "event",
        type: "tool-result",
        toolName: "read_file",
        output: { path: "app/page.tsx", status: "ok" },
      },
      {
        kind: "event",
        type: "tool-error",
        toolName: "validate_app",
        error: "Typecheck failed",
        exitCode: 2,
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
