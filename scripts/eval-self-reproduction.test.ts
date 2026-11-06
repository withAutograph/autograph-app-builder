import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { evidencePrefix } from "../evals/support/self-reproduction-evidence";

const outputs: string[] = [];
afterEach(() => {
  for (const output of outputs.splice(0)) {
    rmSync(output, { force: true, recursive: true });
  }
});

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function run(script: string, reportOnly = false) {
  const output = mkdtempSync(nodePath.join(tmpdir(), "self-reproduction-report-test-"));
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
      ...(reportOnly ? ["--report-only"] : []),
    ],
    {
      cwd: nodePath.resolve(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        HOME: process.env.HOME,
        NODE_ENV: "test",
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
      },
      timeout: 30_000,
    },
  );
  expect(result.error).toBeUndefined();
  const report = JSON.parse(readFileSync(nodePath.join(output, "report.json"), "utf-8"));
  // All failure modes must produce the same reviewable bundle.
  for (const path of [
    "report.md",
    "index.html",
    "receipt.json",
    "settings.json",
    "revisions.json",
    "native-result.json",
    "candidate-inventory.json",
    "candidate-runtime.json",
    "generation-transcript.jsonl",
    "parity-evidence.json",
    "parity-assessment.json",
  ]) {
    expect(() => readFileSync(nodePath.join(output, path))).not.toThrow();
  }
  for (const path of ["brief.md", "answers.json"]) {
    expect(readFileSync(nodePath.join(output, "generator-input", path), "utf-8")).toBe(
      readFileSync(nodePath.resolve("evals/self-reproduction", path), "utf-8"),
    );
  }
  expect(existsSync(nodePath.join(output, "runtime-source"))).toBe(false);
  expect(
    JSON.parse(readFileSync(nodePath.join(output, "revisions.json"), "utf-8")).arrusted.status,
  ).toBe("unavailable");
  return { output, report, result };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function emit(records: unknown[], verdict = "passed") {
  return `${records
    .map((record) => `console.log(${JSON.stringify(evidencePrefix + JSON.stringify(record))});`)
    .join(
      "\n",
    )}console.log(JSON.stringify({results:[{id:"self-reproduction",verdict:${JSON.stringify(verdict)}}]},null,2));`;
}

describe("native self-reproduction report orchestration", () => {
  it("labels report-only configuration without inventing generation evidence", () => {
    const { result, report, output } = run("throw new Error('GENERATOR_MUST_NOT_RUN')", true);
    expect(result.status).toBe(0);
    expect(report.generation.status).toBe("not-run");
    expect(report.candidateRuntime.status).toBe("not-run");
    expect(report.settings).toMatchObject({
      modelInvocation: "unverified: report-only does not run generation",
      status: "source-config-only",
    });
    expect(report.settings.configuredModel).toBeTypeOf("string");
    expect(report.settings).not.toHaveProperty("runtimeIdentity");
    expect(report.settings.publication).not.toContain("sandbox eval profile");
    expect(readFileSync(nodePath.join(output, "generation-transcript.jsonl"), "utf-8")).toBe("");
    expect(JSON.stringify(report)).not.toContain("GENERATOR_MUST_NOT_RUN");
  });

  it("writes partial reports and unavailable markers when the launcher emits nothing", () => {
    const { result, report } = run("");
    expect(result.status).toBe(1);
    expect(report.generation.status).toBe("failed");
    expect(report.candidate.status).toBe("unavailable");
    expect(report.transcript.status).toBe("unavailable");
    expect(report.requirements).toHaveLength(76);
    expect(
      report.requirements
        .filter(
          (item: { side: string; requirementId: string }) =>
            item.side === "candidate" && item.requirementId !== "anonymous-entry",
        )
        .every((item: { status: string }) => item.status === "failed"),
    ).toBe(true);
    expect(
      report.requirements.filter(
        (item: { requirementId: string }) => item.requirementId === "anonymous-entry",
      ),
    ).toEqual([
      expect.objectContaining({
        reasonCode: "excluded-from-scope",
        side: "reference",
        status: "unassessed",
      }),
      expect.objectContaining({
        reasonCode: "excluded-from-scope",
        side: "candidate",
        status: "unassessed",
      }),
    ]);
    expect(report.diagnostics.note).toContain("never award parity credit");
  });

  it("retains tool errors, settings, and reports after a partial native failure", () => {
    const { result, report, output } = run(
      `${emit(
        [
          {
            event: {
              data: {
                result: { output: "AppSpec invalid", token: "private-secret" },
                status: "failed",
              },
              type: "action.result",
            },
            kind: "event",
          },
        ],
        "failed",
      )}process.exitCode = 1;`,
    );
    expect(result.status).toBe(1);
    expect(report.generation.status).toBe("failed");
    const transcript = readFileSync(nodePath.join(output, "generation-transcript.jsonl"), "utf-8");
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

  it("persists a candidate exported by the native reviewed change set", () => {
    const exportEvent = {
      event: {
        data: {
          result: {
            exportFiles: [
              {
                content: "export default function Page() { return null; }\n",
                path: "apps/replica/app/page.tsx",
              },
            ],
          },
          toolName: "change_set_status",
        },
        type: "action.result",
      },
      kind: "event",
    };
    const { result, report, output } = run(emit([exportEvent, { kind: "eval-completed" }]));
    expect(result.status).toBe(0);
    expect(report.candidate).toMatchObject({
      provenance: "native reviewed change-set-status export",
      status: "available",
    });
    expect(
      readFileSync(nodePath.join(output, "candidate/apps/replica/app/page.tsx"), "utf-8"),
    ).toContain("export default function Page");
  });

  it("reports a completed native eval without claiming candidate or capture proof", () => {
    const { result, report } = run(emit([{ kind: "event" }, { kind: "eval-completed" }]));
    expect(result.status).toBe(0);
    expect(report.generation.status).toBe("completed");
    expect(report.candidate.status).toBe("unavailable");
    expect(report.captures).toEqual([
      { files: [], label: "reference", status: "unassessed: URL not supplied" },
      { files: [], label: "candidate", status: "unassessed: URL not supplied" },
    ]);
  });
});

it("rejects default generation before creating output or launching setup", () => {
  const parent = mkdtempSync(nodePath.join(tmpdir(), "self-reproduction-entry-guard-"));
  outputs.push(parent);
  const output = nodePath.join(parent, "must-not-exist");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/eval-self-reproduction.mts", "--output-dir", output],
    {
      cwd: nodePath.resolve(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        HOME: process.env.HOME,
        NODE_ENV: "production",
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
      },
      timeout: 30_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("requires the public App Builder entrypoint");
  expect(existsSync(output)).toBe(false);
});
