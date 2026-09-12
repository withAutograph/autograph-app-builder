import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { evidencePrefix } from "../evals/support/self-reproduction-evidence";

const outputs: string[] = [];
afterEach(() => {
  for (const output of outputs.splice(0)) rmSync(output, { recursive: true, force: true });
});

function run(script: string) {
  const output = mkdtempSync(join(tmpdir(), "self-reproduction-report-test-"));
  outputs.push(output);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/eval-self-reproduction.mts",
      "--output-dir",
      output,
      "--generator",
      process.execPath,
      "--generator-arg=-e",
      `--generator-arg=${script}`,
    ],
    {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf-8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: "test",
      },
    },
  );
  expect(result.error).toBeUndefined();
  const report = JSON.parse(readFileSync(join(output, "report.json"), "utf-8"));
  // All failure modes must produce the same reviewable bundle.
  for (const path of [
    "report.md",
    "index.html",
    "receipt.json",
    "settings.json",
    "revisions.json",
    "native-result.json",
    "candidate-inventory.json",
    "generation-transcript.jsonl",
  ])
    expect(() => readFileSync(join(output, path))).not.toThrow();
  for (const path of ["brief.md", "answers.json"])
    expect(readFileSync(join(output, "generator-input", path), "utf-8")).toBe(
      readFileSync(resolve("evals/self-reproduction", path), "utf-8"),
    );
  return { result, report, output };
}

function emit(records: unknown[], verdict = "passed") {
  return (
    `${records
      .map((record) => `console.log(${JSON.stringify(evidencePrefix + JSON.stringify(record))});`)
      .join("\n") 
    }console.log(JSON.stringify({results:[{id:"self-reproduction",verdict:${JSON.stringify(verdict)}}]},null,2));`
  );
}

describe("native self-reproduction report orchestration", () => {
  it("writes partial reports and unavailable markers when the launcher emits nothing", () => {
    const { result, report } = run("");
    expect(result.status).toBe(1);
    expect(report.generation.status).toBe("failed");
    expect(report.candidate.status).toBe("unavailable");
    expect(report.transcript.status).toBe("unavailable");
    expect(
      report.requirements
        .filter((item: { id: string }) => !item.id.startsWith("reference-"))
        .every((item: { status: string }) => item.status === "blocked"),
    ).toBe(true);
  });

  it("retains tool errors, settings, and reports after a partial native failure", () => {
    const { result, report, output } = run(
      `${emit(
        [
          {
            kind: "event",
            event: {
              type: "action.result",
              data: {
                status: "failed",
                result: { output: "AppSpec invalid", token: "private-secret" },
              },
            },
          },
        ],
        "failed",
      )  }process.exitCode = 1;`,
    );
    expect(result.status).toBe(1);
    expect(report.generation.status).toBe("failed");
    const transcript = readFileSync(join(output, "generation-transcript.jsonl"), "utf-8");
    expect(transcript).toContain("AppSpec invalid");
    expect(transcript).not.toContain("private-secret");
    expect(report.generation.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(report.revisions.builder.commit).toMatch(/^[a-f0-9]{40}$/u);
  });

  it("keeps strict native failures failed even when the child returns zero", () => {
    const { result, report } = run(emit([{ kind: "event" }, { kind: "eval-completed" }], "failed"));
    expect(result.status).toBe(1);
    expect(report.generation.reason).toBe("Native strict eval did not pass.");
  });

  it("reports a completed native eval without claiming candidate or capture proof", () => {
    const { result, report } = run(emit([{ kind: "event" }, { kind: "eval-completed" }]));
    expect(result.status).toBe(0);
    expect(report.generation.status).toBe("completed");
    expect(report.candidate.status).toBe("unavailable");
    expect(report.captures).toEqual([
      { label: "reference", files: [], status: "unassessed: URL not supplied" },
      { label: "candidate", files: [], status: "unassessed: URL not supplied" },
    ]);
  });
});
