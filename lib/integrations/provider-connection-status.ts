import { z } from "zod";

export const providerConnectionFailureReasonSchema = z.enum([
  "configuration-unavailable",
  "request-invalid",
  "authorization-failed",
  "callback-invalid",
]);

export type ProviderConnectionFailureReason = z.infer<
  typeof providerConnectionFailureReasonSchema
>;

export type ProviderConnectionNotice = {
  provider: "github" | "vercel";
  status: "connected" | "failed";
  reason?: ProviderConnectionFailureReason;
};

export function parseProviderConnectionFailureReason(input: unknown) {
  const parsed = providerConnectionFailureReasonSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

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
  return `${provider} could not be connected. Try again, or contact support if the problem continues.`;
}
