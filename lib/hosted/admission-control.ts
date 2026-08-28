import { z } from "zod";

import {
  hostedDeploymentEnvironmentSchema,
  readHostedDeploymentEnvironment,
} from "./deployment-environment";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const instantSchema = z.string().datetime({ offset: true });

export const hostedAdmissionControlBindingSchema = z
  .object({
    version: z.literal(1),
    environment: hostedDeploymentEnvironmentSchema,
    enforcement: z.literal("provider-readback"),
    scope: z.literal("issuer-audience-workspace-subject"),
    startsPerSubjectPerMinute: z.number().int().min(1).max(60),
    startsPerWorkspacePerMinute: z.number().int().min(1).max(300),
    maxConcurrentSessionsPerSubject: z.number().int().min(1).max(10),
    maxActiveSessionsPerWorkspace: z.number().int().min(1).max(100),
    monthlySpendUsedUsdCents: z.number().int().min(0).max(1_000_000),
    monthlySpendLimitUsdCents: z.number().int().min(1).max(1_000_000),
    observedAt: instantSchema,
    expiresAt: instantSchema,
    readbackDigest: sha256Schema,
  })
  .strict()
  .superRefine((binding, context) => {
    const observedAt = Date.parse(binding.observedAt);
    const expiresAt = Date.parse(binding.expiresAt);
    if (
      expiresAt <= observedAt ||
      expiresAt - observedAt > 24 * 60 * 60 * 1_000
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message:
          "Hosted admission-control readback must expire within 24 hours.",
      });
    }
    if (binding.monthlySpendUsedUsdCents >= binding.monthlySpendLimitUsdCents) {
      context.addIssue({
        code: "custom",
        path: ["monthlySpendUsedUsdCents"],
        message: "Hosted monthly spend is at or above its configured ceiling.",
      });
    }
  });

export type HostedAdmissionControlBinding = z.infer<
  typeof hostedAdmissionControlBindingSchema
>;

export const hostedPreviewAdmissionControlBindingSchema =
  hostedAdmissionControlBindingSchema.refine(
    (binding) => binding.environment === "preview",
    "Preview admission control must bind the Preview environment.",
  );

export type HostedPreviewAdmissionControlBinding = z.infer<
  typeof hostedPreviewAdmissionControlBindingSchema
>;

export function readHostedAdmissionControlBinding(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  nowEpochMs = Date.now(),
): HostedAdmissionControlBinding {
  const deploymentEnvironment = readHostedDeploymentEnvironment(environment);
  const serialized = environment.EVE_HOSTED_ADMISSION_CONTROL;
  if (
    serialized === undefined ||
    serialized.length === 0 ||
    serialized.length > 4_096 ||
    /[\0\r\n]/u.test(serialized)
  ) {
    throw new Error("A bounded hosted admission-control readback is required.");
  }

  const binding = hostedAdmissionControlBindingSchema.parse(
    JSON.parse(serialized),
  );
  if (binding.environment !== deploymentEnvironment) {
    throw new Error(
      "Hosted admission control must match the deployment environment.",
    );
  }
  const observedAt = Date.parse(binding.observedAt);
  const expiresAt = Date.parse(binding.expiresAt);
  if (observedAt > nowEpochMs + 30_000 || nowEpochMs >= expiresAt) {
    throw new Error("Hosted admission-control readback is stale.");
  }
  return binding;
}

export function readHostedPreviewAdmissionControlBinding(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  nowEpochMs = Date.now(),
): HostedPreviewAdmissionControlBinding {
  return hostedPreviewAdmissionControlBindingSchema.parse(
    readHostedAdmissionControlBinding(environment, nowEpochMs),
  );
}
