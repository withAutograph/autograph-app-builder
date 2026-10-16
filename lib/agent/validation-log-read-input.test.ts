import { describe, expect, it } from "vitest";
import {
  validationAttemptLogReadInputs,
  validationLogReadInput,
  validationLogsWithReadInputs,
} from "./validation-log-read-input";
import type { TargetValidationCommandReceipt } from "../repository/target-validation";

export const validationLogCommandFixture: TargetValidationCommandReceipt = {
  command: "mise run --no-deps --skip-tools app:check example",
  exitCode: 1,
  inputTreeDigest: "c".repeat(64),
  logs: {
    stderr: {
      bytes: 42,
      channel: "stderr",
      chunkCount: 1,
      completion: "interrupted",
      digest: "d".repeat(64),
      logId: "123e4567-e89b-42d3-a456-426614174001",
    },
    stdout: {
      bytes: 0,
      channel: "stdout",
      chunkCount: 0,
      completion: "complete",
      digest: "e".repeat(64),
      logId: "123e4567-e89b-42d3-a456-426614174002",
    },
  },
  name: "check-build",
  stderrDigest: "f".repeat(64),
  stdoutDigest: "0".repeat(64),
  validationRoot: "/workspace/repository",
};

const attemptDigest = "a".repeat(64);

describe("canonical validation log read inputs", () => {
  it("constructs the complete channel tuple from the actual attempt, command name, and reference", () => {
    const reference = validationLogCommandFixture.logs?.stderr;
    if (reference === undefined) {
      throw new Error("Expected the fixture's stderr reference.");
    }
    expect(
      validationLogReadInput(attemptDigest, validationLogCommandFixture.name, reference),
    ).toEqual({
      attemptDigest,
      channel: "stderr",
      command: "check-build",
      digest: reference.digest,
      logId: reference.logId,
    });
  });

  it.each(["failed", "passed"] as const)(
    "presents %s receipt channels without mutating the receipt",
    (status) => {
      const receipt = { attemptDigest, commands: [validationLogCommandFixture], status };
      const original = JSON.stringify(receipt);
      const presented = validationAttemptLogReadInputs(receipt);
      expect(presented.attemptDigest).toBe(attemptDigest);
      expect(presented.status).toBe(status);
      expect(Object.keys(presented.commands[0] ?? {})).toEqual(["logs", "name"]);
      expect(presented.commands[0]?.name).toBe("check-build");
      for (const field of [
        "command",
        "validationRoot",
        "inputTreeDigest",
        "stdoutDigest",
        "stderrDigest",
        "exitCode",
      ]) {
        expect(presented.commands[0]).not.toHaveProperty(field);
      }
      expect(presented.commands[0]?.logs?.stderr).toMatchObject({
        completion: "interrupted",
        readInput: {
          attemptDigest,
          channel: "stderr",
          command: "check-build",
          digest: "d".repeat(64),
          logId: "123e4567-e89b-42d3-a456-426614174001",
        },
      });
      expect(presented.commands[0]?.logs?.stdout.readInput).toMatchObject({
        attemptDigest,
        channel: "stdout",
        digest: "e".repeat(64),
        logId: "123e4567-e89b-42d3-a456-426614174002",
      });
      expect(JSON.stringify(receipt)).toBe(original);
    },
  );

  it("does not manufacture references for commands whose logs were not captured", () => {
    const { logs, ...withoutLogs } = validationLogCommandFixture;
    void logs;
    expect(validationLogsWithReadInputs(attemptDigest, withoutLogs)).toBeUndefined();
    expect(
      validationAttemptLogReadInputs({ attemptDigest, commands: [withoutLogs], status: "passed" }),
    ).toEqual({ attemptDigest, commands: [{ name: "check-build" }], status: "passed" });
  });
});
