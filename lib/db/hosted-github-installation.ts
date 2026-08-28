import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "./hosted-admin";
import type { HostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const instantSchema = z.string().datetime({ offset: true });

const planSchema = z
  .object({
    version: z.literal(1),
    action: z.literal("github-installation.bind"),
    authority: hostedTenantAuthoritySchema,
    installation: z
      .object({
        installationId: z.string().regex(/^[1-9][0-9]*$/u),
        accountId: z.string().regex(/^[1-9][0-9]*$/u),
        accountLogin: z
          .string()
          .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u),
        accountType: z.enum(["Organization", "User"]),
      })
      .strict(),
    requestedAt: instantSchema,
  })
  .strict();

export const hostedGitHubInstallationPlanRequestSchema = planSchema;
export const hostedGitHubInstallationApplyRequestSchema = planSchema
  .extend({ confirmationDigest: sha256Schema })
  .strict();

const digest = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function canonical(input: z.infer<typeof planSchema>): string {
  return JSON.stringify({
    version: input.version,
    action: input.action,
    authority: input.authority,
    installation: input.installation,
    requestedAt: input.requestedAt,
  });
}

export function planHostedGitHubInstallation(input: unknown) {
  const request = planSchema.parse(input);
  const requestJson = canonical(request);
  return {
    version: 1 as const,
    action: request.action,
    requestDigest: digest(requestJson),
    authorityDigest: digest(JSON.stringify(request.authority)),
    installationDigest: digest(JSON.stringify(request.installation)),
    requiredConfirmationDigest: digest(`confirm\n${requestJson}`),
    requestedAt: request.requestedAt,
  };
}

export async function bindHostedGitHubInstallation(input: {
  request: unknown;
  store: HostedGitHubInstallationStore;
  now?: () => Date;
}) {
  const request = hostedGitHubInstallationApplyRequestSchema.parse(
    input.request,
  );
  const { confirmationDigest, ...planRequest } = request;
  const plan = planHostedGitHubInstallation(planRequest);
  if (confirmationDigest !== plan.requiredConfirmationDigest)
    throw new Error("Hosted GitHub installation confirmation is invalid.");
  const now = (input.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime()))
    throw new Error("Hosted GitHub installation timestamp is invalid.");
  const binding = await input.store.bind({
    authority: request.authority,
    binding: request.installation,
    now,
  });
  return {
    version: 1 as const,
    action: request.action,
    status: "applied" as const,
    requestDigest: plan.requestDigest,
    authorityDigest: plan.authorityDigest,
    installationDigest: plan.installationDigest,
    appliedAt: now.toISOString(),
    effects: {
      bindingActive: binding.active,
      installationId: binding.installationId,
      accountId: binding.accountId,
      accountLogin: binding.accountLogin,
      accountType: binding.accountType,
    },
    database: {
      dialect: "postgresql" as const,
      secretTransport: "owner-only-request-and-task-scoped-stdin" as const,
      maxConnections: 1 as const,
    },
  };
}
