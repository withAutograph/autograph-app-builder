import { z } from "zod";

export const providerConnectionFailureReasonSchema = z.enum([
  "configuration-unavailable",
  "request-invalid",
  "authorization-failed",
  "callback-invalid",
  "authorization-expired",
  "repository-access-missing",
  "provider-unavailable",
  "account-choice-required",
  "access-denied",
  "installation-not-accessible",
]);

export type ProviderConnectionFailureReason = z.infer<typeof providerConnectionFailureReasonSchema>;

export interface ProviderConnectionNotice {
  provider: "github" | "vercel";
  status: "connected" | "failed";
  reason?: ProviderConnectionFailureReason;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseProviderConnectionFailureReason(input: unknown) {
  const parsed = providerConnectionFailureReasonSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function providerConnectionFailureMessage(
  provider: "GitHub" | "Vercel",
  reason?: ProviderConnectionFailureReason,
) {
  if (reason === "configuration-unavailable") {
    return `${provider} connections have not been configured for this deployment yet. An administrator needs to finish provider setup before you can connect.`;
  }
  if (reason === "request-invalid") {
    return `The ${provider} connection request could not be verified. Return to the builder and start a new connection attempt.`;
  }
  if (reason === "callback-invalid") {
    return `${provider} returned an invalid or expired authorization response. Start a new connection attempt.`;
  }
  if (provider === "GitHub" && reason === "authorization-expired") {
    return "This GitHub connection link has expired. Return to Builder and request a fresh connection link.";
  }
  if (provider === "GitHub" && reason === "repository-access-missing") {
    return "GitHub connected, but the requested repository was not granted. Add it to the GitHub App installation and try again.";
  }
  if (provider === "GitHub" && reason === "provider-unavailable") {
    return "GitHub could not confirm repository access right now. Try again shortly.";
  }
  if (provider === "GitHub" && reason === "account-choice-required") {
    return "More than one connected GitHub account can access this repository. Return to Builder and choose the account to use.";
  }
  if (provider === "GitHub" && reason === "access-denied") {
    return "GitHub access was not approved. Continue with GitHub when you are ready to grant access.";
  }
  if (provider === "GitHub" && reason === "installation-not-accessible") {
    return "This GitHub account cannot access the selected App installation. Use the GitHub account with repository access, then try again.";
  }
  return `${provider} could not be connected. Try again, or contact support if the problem continues.`;
}
