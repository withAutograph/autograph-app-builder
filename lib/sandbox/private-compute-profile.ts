import { z } from "zod";

export const LEGACY_PRIVATE_COMPUTE_CHECK_TASK = `#!/bin/sh\n#MISE description="Check generated application lint and types without formatting"\nset -eu\n\nexec vp check --no-fmt\n`;
export const PRIVATE_COMPUTE_CHECK_TASK = `#!/bin/sh\n#MISE description="Check generated application lint and types without formatting"\nset -eu\n\nexec vp lint --threads=1 --type-aware --type-check\n`;
export const PRIVATE_COMPUTE_PROFILE_ID = "private-checks-16gib-v1" as const;
export const privateComputeLimitsSchema = z
  .strictObject({
    limited: z.literal(false),
    maxVcpus: z.union([z.literal(4), z.literal(8), z.literal(32)]),
    observedAt: z.iso.datetime(),
    plan: z.enum(["hobby", "pro", "enterprise"]),
    projectId: z.string().startsWith("prj_"),
    teamId: z.string().startsWith("team_"),
    version: z.literal(1),
  })
  .superRefine((value, ctx) => {
    const limit = { enterprise: 32, hobby: 4, pro: 8 }[value.plan];
    if (value.maxVcpus !== limit) {
      ctx.addIssue({
        code: "custom",
        message: "Compute limit must match the observed provider plan.",
      });
    }
  });
export type PrivateComputeLimits = z.infer<typeof privateComputeLimitsSchema>;
export const privateComputeProfileSchema = z
  .strictObject({
    checkPolicy: z.strictObject({
      afterSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      beforeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      path: z.string().regex(/^apps\/[a-z][a-z0-9-]*\/\.config\/mise\/tasks\/check$/u),
    }),
    id: z.literal(PRIVATE_COMPUTE_PROFILE_ID),
    limits: privateComputeLimitsSchema,
    lintWorkers: z.literal(1),
    memoryMiB: z.literal(16_384),
    target: z.strictObject({ sandboxId: z.string().min(1), workspaceDrive: z.string().min(1) }),
    vcpus: z.literal(8),
    version: z.literal(1),
  })
  .refine((value) => value.limits.maxVcpus >= value.vcpus, {
    message: "The observed team plan does not support this compute profile.",
  });
export type PrivateComputeProfile = z.infer<typeof privateComputeProfileSchema>;
export const privateComputeApprovalDescription =
  "Use the same private workspace with 8 vCPUs, 16 GiB memory and one lint worker for the app's checks. Vercel bills actual ephemeral usage at its current team rates; this is not a subscription change or prepaid hour. Preserve all lint rules, JavaScript plugins and type checks.";
export const readPrivateComputeLimits = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const raw = environment.APP_BUILDER_PRIVATE_COMPUTE_LIMITS;
  if (raw === undefined || raw === "") {
    throw new Error(
      "The private compute profile needs the supported local launcher's current provider team-plan observation. Restart the same local cycle to obtain it; do not supply a model-authored limit or change resources manually.",
    );
  }
  const observed = privateComputeLimitsSchema.parse(JSON.parse(raw));
  if (
    observed.projectId !== environment.VERCEL_PROJECT_ID ||
    observed.teamId !== environment.VERCEL_TEAM_ID
  ) {
    throw new Error("The compute observation does not match this provider project and team.");
  }
  return observed;
};

export const privateComputeActivationSchema = z.strictObject({
  appId: z.string().min(1),
  completedByCallId: z.string().optional(),
  phase: z.enum(["stopping", "configuring", "resuming", "ready"]),
  profileId: z.literal(PRIVATE_COMPUTE_PROFILE_ID),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  sandboxId: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceDrive: z.string().min(1),
});
export type PrivateComputeActivation = z.infer<typeof privateComputeActivationSchema>;
