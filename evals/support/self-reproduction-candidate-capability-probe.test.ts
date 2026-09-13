import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import {
  exerciseCandidateCapabilities,
  runCandidateCapabilityProbe,
  sandboxCandidateCapabilityProbe,
} from "./self-reproduction-candidate-capability-probe";

it("proves independent infrastructure operations and always stops the child", async () => {
  const stop = vi.fn(async () => {
    await Promise.resolve();
  });
  const receipt = await exerciseCandidateCapabilities({
    createChild: () =>
      Promise.resolve({
        run: () => Promise.resolve({ exitCode: 0, stdout: "candidate-capability-ok" }),
        stop,
      }),
    model: () => Promise.resolve("ready"),
  });
  expect(receipt.model.status).toBe("passed");
  expect(receipt.childSandbox.status).toBe("passed");
  expect(receipt.applicationFunctionalCredit).toBe(false);
  expect(stop).toHaveBeenCalledOnce();
});

it("preserves model failure separately and cleans up after a failed child command", async () => {
  const stop = vi.fn(() => Promise.resolve());
  const receipt = await exerciseCandidateCapabilities({
    createChild: () =>
      Promise.resolve({ run: () => Promise.reject(new Error("raw-secret")), stop }),
    model: () => Promise.reject(new Error("raw-secret")),
  });
  expect(receipt.model.status).toBe("blocked");
  expect(receipt.childSandbox.status).toBe("blocked");
  expect(receipt.childCleanup.status).toBe("passed");
  expect(JSON.stringify(receipt)).not.toContain("raw-secret");
});

it("fails incorrect command output and records cleanup failure", async () => {
  const receipt = await exerciseCandidateCapabilities({
    createChild: () =>
      Promise.resolve({
        run: () => Promise.resolve({ exitCode: 0, stdout: "wrong" }),
        stop: () => Promise.reject(new Error("failure")),
      }),
    model: () => Promise.resolve(""),
  });
  expect(receipt.model.status).toBe("failed");
  expect(receipt.childSandbox.status).toBe("failed");
  expect(receipt.childCleanup.status).toBe("failed");
  expect(sandboxCandidateCapabilityProbe().script).toContain('networkPolicy: "allow-all"');
});

it("serializes a valid standalone Node module without credentials", () => {
  const { script } = sandboxCandidateCapabilityProbe();
  const checked = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    encoding: "utf-8",
    input: script,
  });
  expect(checked.stderr).toBe("");
  expect(checked.status).toBe(0);
});

it("retains failed scratch installation without attempting a product mutation", async () => {
  const writeTextFile = vi.fn(() => Promise.resolve());
  const run = vi.fn(() =>
    Promise.resolve({ exitCode: 1, stderr: "install failed", stdout: "install output" }),
  );
  const receipt = await runCandidateCapabilityProbe({
    abortSignal: new AbortController().signal,
    model: "openai/gpt-5.6-terra",
    session: { readBinaryFile: vi.fn(), readTextFile: vi.fn(), run, writeTextFile } as never,
  });
  expect(writeTextFile).toHaveBeenCalledWith(
    expect.objectContaining({ path: ".scratch/self-reproduction-capabilities/package.json" }),
  );
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]).toBeDefined();
  expect(receipt.status).toBe("blocked");
  expect(receipt.setup.stderr).toBe("install failed");
  expect(receipt.comparison).toBeNull();
});

it("runs the standalone probe only after scratch tooling setup", async () => {
  const writes: string[] = [];
  const run = vi.fn(() => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }));
  const receipt = await runCandidateCapabilityProbe({
    abortSignal: new AbortController().signal,
    model: "openai/gpt-5.6-terra",
    session: {
      readBinaryFile: vi.fn(),
      readTextFile: () => Promise.resolve(JSON.stringify({ applicationFunctionalCredit: false })),
      run,
      writeTextFile: ({ path }: { path: string }) => {
        writes.push(path);
        return Promise.resolve();
      },
    } as never,
  });
  expect(writes[0]).toBe(".scratch/self-reproduction-capabilities/package.json");
  expect(
    writes.every(
      (path) => path.startsWith(".scratch/") || path.startsWith(".self-reproduction-comparison/"),
    ),
  ).toBe(true);
  expect(run).toHaveBeenCalledTimes(2);
  expect(receipt.status).toBe("completed");
});
