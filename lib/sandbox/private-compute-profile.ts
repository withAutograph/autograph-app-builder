import { z } from "zod";

export const LEGACY_PRIVATE_COMPUTE_CHECK_TASK = `#!/bin/sh\n#MISE description="Check generated application lint and types without formatting"\nset -eu\n\nexec vp check --no-fmt\n`;
export const PRIVATE_COMPUTE_CHECK_TASK = `#!/bin/sh\n#MISE description="Check generated application lint and types without formatting"\nset -eu\n\nexec vp lint --threads=1 --type-aware --type-check\n`;
export const PRIVATE_COMPUTE_PROFILE_ID = "private-checks-16gib-v1" as const;
export const privateComputeLimitsSchema = z
  .strictObject({
    version: z.literal(1),
    teamId: z.string().startsWith("team_"),
    projectId: z.string().startsWith("prj_"),
    plan: z.enum(["hobby", "pro", "enterprise"]),
    maxVcpus: z.union([z.literal(4), z.literal(8), z.literal(32)]),
    limited: z.literal(false),
    observedAt: z.iso.datetime(),
  })
  .superRefine((value, ctx) => {
    const limit = { hobby: 4, pro: 8, enterprise: 32 }[value.plan];
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
    version: z.literal(1),
    id: z.literal(PRIVATE_COMPUTE_PROFILE_ID),
    vcpus: z.literal(8),
    memoryMiB: z.literal(16_384),
    lintWorkers: z.literal(1),
    checkPolicy: z.strictObject({
      path: z.string().regex(/^apps\/[a-z][a-z0-9-]*\/\.config\/mise\/tasks\/check$/u),
      beforeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      afterSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
    target: z.strictObject({ sandboxId: z.string().min(1), workspaceDrive: z.string().min(1) }),
    limits: privateComputeLimitsSchema,
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
  sandboxId: z.string().min(1),
  workspaceDrive: z.string().min(1),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  appId: z.string().min(1),
  sessionId: z.string().min(1),
  phase: z.enum(["stopping", "configuring", "resuming", "ready"]),
  profileId: z.literal(PRIVATE_COMPUTE_PROFILE_ID),
  completedByCallId: z.string().optional(),
});
export type PrivateComputeActivation = z.infer<typeof privateComputeActivationSchema>;
