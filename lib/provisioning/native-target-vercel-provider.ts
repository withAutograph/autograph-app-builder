import { z } from "zod";

import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import { hostedOperatorAppProjectSettingsSchema } from "./hosted-operator-app-project-settings";
import type { HostedOperatorAppProjectSettings } from "./hosted-operator-app-project-settings";
import { nativeTargetProjectProtectionSchema } from "./native-target-onboarding-contract";
import type { NativeTargetProjectProtection } from "./native-target-onboarding-contract";

const projectSchema = z.looseObject({
  accountId: z.string().min(1),
  buildCommand: z.string().nullable().optional(),
  framework: z.string().nullable().optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  rootDirectory: z.string().nullable().optional(),
  sourceFilesOutsideRootDirectory: z.boolean().optional(),
  ssoProtection: z.looseObject({ deploymentType: z.string() }).nullable(),
  oidcTokenConfig: z.looseObject({ enabled: z.boolean(), issuerMode: z.string() }).nullable(),
});

type Project = z.infer<typeof projectSchema>;

export type NativeTargetVercelProjectObservation =
  | {
      status: "verified";
      projectId: string;
      name: string;
      settings: HostedOperatorAppProjectSettings;
      protection: NativeTargetProjectProtection;
      scopeId: string;
    }
  | { status: "candidate"; projectId: string; reason: "name_or_profile_mismatch" }
  | {
      status: "uncertain";
      projectId: string;
      reason: "invalid_response" | "provider_unavailable" | "unobserved_project";
    };

/* oxlint-disable sonarjs/max-union-size -- Each provider outcome carries a distinct durable write meaning. */
export type NativeTargetVercelProjectCreation =
  | NativeTargetVercelProjectObservation
  | { status: "uncertain"; reason: "receipt_unavailable" | "unknown_write"; projectId?: string }
  | {
      status: "rejected";
      reason:
        | "authorization_denied"
        | "collision"
        | "permission_denied"
        | "provider_rejected"
        | "rate_limited";
    };
/* oxlint-enable sonarjs/max-union-size */

interface ProviderInput {
  installation: VercelInstallationBinding;
  token: string;
  name: string;
  settings: HostedOperatorAppProjectSettings;
  protection: NativeTargetProjectProtection;
  fetch?: typeof fetch;
}

const queryFor = (installation: VercelInstallationBinding): string =>
  installation.scopeType === "team" ? `?teamId=${encodeURIComponent(installation.scopeId)}` : "";

const projectMatches = (project: Project, input: ProviderInput, projectId: string): boolean => {
  if (
    project.id !== projectId ||
    project.name !== input.name ||
    project.accountId !== input.installation.scopeId
  ) {
    return false;
  }
  const frameworkMatches =
    input.settings.framework === undefined ||
    (project.framework ?? null) === input.settings.framework;
  if (!frameworkMatches || project.rootDirectory !== input.settings.rootDirectory) {
    return false;
  }
  const buildCommandMatches =
    input.settings.buildCommand === undefined ||
    (project.buildCommand ?? null) === input.settings.buildCommand;
  const outsideRootMatches =
    input.settings.sourceFilesOutsideRootDirectory === undefined ||
    project.sourceFilesOutsideRootDirectory === input.settings.sourceFilesOutsideRootDirectory;
  const protectionMatch =
    project.ssoProtection?.deploymentType === input.protection.ssoProtection.deploymentType &&
    project.oidcTokenConfig?.enabled === input.protection.oidcTokenConfig.enabled &&
    project.oidcTokenConfig?.issuerMode === input.protection.oidcTokenConfig.issuerMode;
  return buildCommandMatches && outsideRootMatches && protectionMatch;
};

/** Read only the already accepted project ID; a name match is never ownership evidence. */
export const observeNativeTargetVercelProject = async (
  input: ProviderInput & { projectId: string },
): Promise<NativeTargetVercelProjectObservation> => {
  const settings = hostedOperatorAppProjectSettingsSchema.parse(input.settings);
  const protection = nativeTargetProjectProtectionSchema.parse(input.protection);
  if (!input.installation.active || input.token === "") {
    return { status: "uncertain", projectId: input.projectId, reason: "provider_unavailable" };
  }
  const request = input.fetch ?? fetch;
  let response: Response;
  try {
    response = await request(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(input.projectId)}${queryFor(input.installation)}`,
      {
        headers: { Accept: "application/json", Authorization: `Bearer ${input.token}` },
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    return { status: "uncertain", projectId: input.projectId, reason: "provider_unavailable" };
  }
  if (response.status === 404) {
    return { status: "uncertain", projectId: input.projectId, reason: "unobserved_project" };
  }
  if (response.status !== 200) {
    return { status: "uncertain", projectId: input.projectId, reason: "provider_unavailable" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "uncertain", projectId: input.projectId, reason: "invalid_response" };
  }
  const parsed = projectSchema.safeParse(body);
  if (!parsed.success) {
    return { status: "uncertain", projectId: input.projectId, reason: "invalid_response" };
  }
  if (!projectMatches(parsed.data, { ...input, settings, protection }, input.projectId)) {
    return { status: "candidate", projectId: input.projectId, reason: "name_or_profile_mismatch" };
  }
  return {
    status: "verified",
    projectId: input.projectId,
    name: input.name,
    settings,
    protection: nativeTargetProjectProtectionSchema.parse({
      ssoProtection: { deploymentType: parsed.data.ssoProtection?.deploymentType },
      oidcTokenConfig: {
        enabled: parsed.data.oidcTokenConfig?.enabled,
        issuerMode: parsed.data.oidcTokenConfig?.issuerMode,
      },
    }),
    scopeId: input.installation.scopeId,
  };
};

/** The journal caller must authorize and durably record this one attempt before dispatch. */
export const createNativeTargetVercelProject = async (
  input: ProviderInput & {
    authorizeAttempt: () => Promise<void>;
    acceptProjectId: (projectId: string) => Promise<void>;
  },
): Promise<NativeTargetVercelProjectCreation> => {
  const settings = hostedOperatorAppProjectSettingsSchema.parse(input.settings);
  const protection = nativeTargetProjectProtectionSchema.parse(input.protection);
  if (!input.installation.active || input.name.trim() === "" || input.token === "") {
    return { status: "rejected", reason: "authorization_denied" };
  }
  try {
    await input.authorizeAttempt();
  } catch {
    return { status: "rejected", reason: "authorization_denied" };
  }

  // Once dispatched, an exception or unreadable response is an unknown write.
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(
      `https://api.vercel.com/v11/projects${queryFor(input.installation)}`,
      {
        body: JSON.stringify({
          name: input.name,
          framework: settings.framework,
          rootDirectory: settings.rootDirectory,
          // The create API rejects this update-only field. Independent readback below
          // still requires its requested value before this project can be registered.
          ...(settings.buildCommand === undefined ? {} : { buildCommand: settings.buildCommand }),
          ssoProtection: protection.ssoProtection,
          oidcTokenConfig: protection.oidcTokenConfig,
        }),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json",
          "User-Agent": "autograph-app-builder-provisioning",
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    return { status: "uncertain", reason: "unknown_write" };
  }
  if (response.status === 409) {
    return { status: "rejected", reason: "collision" };
  }
  if (response.status === 401 || response.status === 403) {
    return { status: "rejected", reason: "permission_denied" };
  }
  if (response.status === 429) {
    return { status: "rejected", reason: "rate_limited" };
  }
  if (response.status === 400 || response.status === 422) {
    return { status: "rejected", reason: "provider_rejected" };
  }
  if (response.status !== 200 && response.status !== 201) {
    return { status: "uncertain", reason: "unknown_write" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "uncertain", reason: "unknown_write" };
  }
  const accepted = z.looseObject({ id: z.string().min(1) }).safeParse(body);
  if (!accepted.success) {
    return { status: "uncertain", reason: "unknown_write" };
  }
  try {
    await input.acceptProjectId(accepted.data.id);
  } catch {
    return { status: "uncertain", reason: "receipt_unavailable", projectId: accepted.data.id };
  }
  return await observeNativeTargetVercelProject({
    ...input,
    settings,
    protection,
    projectId: accepted.data.id,
  });
};
