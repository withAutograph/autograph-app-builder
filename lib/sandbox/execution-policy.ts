import { createHash } from "node:crypto";

import { z } from "zod";

export const sandboxExecutionPolicySchema = z
  .object({
    command: z.object({
      maximumKillCleanupTimeMs: z.literal(2000),
      maximumNoOutputTimeMs: z.literal(60_000),
      maximumOutputBytes: z.literal(1_048_576),
      maximumWallTimeMs: z.literal(300_000),
    }),
    lease: z.object({
      heartbeatMs: z.literal(60_000),
      ttlMs: z.literal(900_000),
    }),
    provider: z.object({
      memoryBytes: z.literal(4_294_967_296),
      networkPolicy: z.literal("allow-all"),
      ports: z.tuple([]),
      timeoutMs: z.literal(900_000),
      vcpus: z.literal(2),
    }),
    version: z.literal(1),
  })
  .strict();

export type SandboxExecutionPolicy = z.infer<typeof sandboxExecutionPolicySchema>;

export const SANDBOX_EXECUTION_POLICY = sandboxExecutionPolicySchema.parse({
  command: {
    maximumKillCleanupTimeMs: 2000,
    maximumNoOutputTimeMs: 60_000,
    maximumOutputBytes: 1_048_576,
    maximumWallTimeMs: 300_000,
  },
  lease: {
    heartbeatMs: 60_000,
    ttlMs: 900_000,
  },
  provider: {
    memoryBytes: 4_294_967_296,
    networkPolicy: "allow-all",
    ports: [],
    timeoutMs: 900_000,
    vcpus: 2,
  },
  version: 1,
});

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function sandboxExecutionPolicyDigest(
  policy: SandboxExecutionPolicy = SANDBOX_EXECUTION_POLICY,
): string {
  const parsed = sandboxExecutionPolicySchema.parse(policy);
  return `sha256:${createHash("sha256").update(JSON.stringify(parsed)).digest("hex")}`;
}
