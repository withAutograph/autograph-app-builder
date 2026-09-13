import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import {
  exerciseCandidateCapabilities,
  sandboxCandidateCapabilityProbe,
} from "./self-reproduction-candidate-capability-probe";

it("proves independent infrastructure operations and always stops the child", async () => {
  const stop = vi.fn(async () => {
    await Promise.resolve();
  });
  const receipt = await exerciseCandidateCapabilities({
    model: () => Promise.resolve("ready"),
    createChild: () =>
      Promise.resolve({
        run: () => Promise.resolve({ exitCode: 0, stdout: "candidate-capability-ok" }),
        stop,
      }),
  });
  expect(receipt.model.status).toBe("passed");
  expect(receipt.childSandbox.status).toBe("passed");
  expect(receipt.applicationFunctionalCredit).toBe(false);
  expect(stop).toHaveBeenCalledOnce();
});

it("preserves model failure separately and cleans up after a failed child command", async () => {
  const stop = vi.fn(() => Promise.resolve());
  const receipt = await exerciseCandidateCapabilities({
    model: () => Promise.reject(new Error("raw-secret")),
    createChild: () =>
      Promise.resolve({ run: () => Promise.reject(new Error("raw-secret")), stop }),
  });
  expect(receipt.model.status).toBe("blocked");
  expect(receipt.childSandbox.status).toBe("blocked");
  expect(receipt.childCleanup.status).toBe("passed");
  expect(JSON.stringify(receipt)).not.toContain("raw-secret");
});

it("fails incorrect command output and records cleanup failure", async () => {
  const receipt = await exerciseCandidateCapabilities({
    model: () => Promise.resolve(""),
    createChild: () =>
      Promise.resolve({
        run: () => Promise.resolve({ exitCode: 0, stdout: "wrong" }),
        stop: () => Promise.reject(new Error("failure")),
      }),
  });
  expect(receipt.model.status).toBe("failed");
  expect(receipt.childSandbox.status).toBe("failed");
  expect(receipt.childCleanup.status).toBe("failed");
  expect(sandboxCandidateCapabilityProbe().script).toContain('networkPolicy: "allow-all"');
});

it("serializes a valid standalone Node module without credentials", () => {
  const { script } = sandboxCandidateCapabilityProbe();
  const checked = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: script,
    encoding: "utf-8",
  });
  expect(checked.stderr).toBe("");
  expect(checked.status).toBe(0);
});
