import { createHash } from "node:crypto";

import { z } from "zod";

export const sandboxExecutionPolicySchema = z
  .object({
    version: z.literal(1),
    provider: z.object({
      vcpus: z.literal(2),
      memoryBytes: z.literal(4_294_967_296),
      timeoutMs: z.literal(900_000),
      ports: z.tuple([]),
      networkPolicy: z.literal("deny-all"),
    }),
    lease: z.object({
      ttlMs: z.literal(900_000),
      heartbeatMs: z.literal(60_000),
      maxActivePerSubject: z.literal(1),
      maxActivePerWorkspace: z.literal(4),
    }),
    command: z.object({
      maximumWallTimeMs: z.literal(300_000),
      maximumOutputBytes: z.literal(1_048_576),
      maximumProcesses: z.literal(128),
      maximumOpenFiles: z.literal(256),
      maximumFileBytes: z.literal(134_217_728),
      maximumWorkspaceBytes: z.literal(2_147_483_648),
      maximumWorkspaceFiles: z.literal(100_000),
    }),
  })
  .strict();

export type SandboxExecutionPolicy = z.infer<
  typeof sandboxExecutionPolicySchema
>;

export const SANDBOX_EXECUTION_POLICY = sandboxExecutionPolicySchema.parse({
  version: 1,
  provider: {
    vcpus: 2,
    memoryBytes: 4_294_967_296,
    timeoutMs: 900_000,
    ports: [],
    networkPolicy: "deny-all",
  },
  lease: {
    ttlMs: 900_000,
    heartbeatMs: 60_000,
    maxActivePerSubject: 1,
    maxActivePerWorkspace: 4,
  },
  command: {
    maximumWallTimeMs: 300_000,
    maximumOutputBytes: 1_048_576,
    maximumProcesses: 128,
    maximumOpenFiles: 256,
    maximumFileBytes: 134_217_728,
    maximumWorkspaceBytes: 2_147_483_648,
    maximumWorkspaceFiles: 100_000,
  },
});

export function sandboxExecutionPolicyDigest(
  policy: SandboxExecutionPolicy = SANDBOX_EXECUTION_POLICY,
): string {
  const parsed = sandboxExecutionPolicySchema.parse(policy);
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(parsed))
    .digest("hex")}`;
}
