import { z } from "zod";

const configuration = z.object({
  disabledAt: z.number().nonnegative().nullish(),
  disabledReason: z.string().min(1).nullish(),
  id: z.string().min(1),
  ownerId: z.string().min(1),
  projectSelection: z.enum(["all", "selected"]),
  scopes: z.array(z.string()),
  teamId: z.string().min(1),
});
const providerCode = z.enum([
  "invalid_token",
  "integration_configuration_disabled",
  "forbidden",
  "unauthorized",
  "not_found",
]);
export const nativeTargetProviderAuthorizationSchema = z.object({
  allProjectsConfigured: z.boolean().optional(),
  disabled: z.boolean().optional(),
  failure: z
    .enum([
      "provider_rejected",
      "invalid_response",
      "request_failed",
      "cancelled",
      "credential_unavailable",
    ])
    .optional(),
  installationMatches: z.boolean().optional(),
  ownerMatches: z.boolean().optional(),
  projectWriteConfigured: z.boolean().optional(),
  providerCode: providerCode.or(z.literal("unknown")).optional(),
  status: z.enum(["observed", "unavailable"]),
  statusCode: z.number().int().min(100).max(599).optional(),
  teamMatches: z.boolean().optional(),
});
export type NativeTargetVercelAuthorizationObservation = z.infer<
  typeof nativeTargetProviderAuthorizationSchema
>;

// Installation configuration is small metadata; cap untrusted provider input at 64 KiB.
const readConfigurationJson = async (response: Response, signal: AbortSignal): Promise<string> => {
  signal.throwIfAborted();
  if (!response.body) {
    throw new Error("missing_body");
  }
  const reader = response.body.getReader();
  const discard = async () => {
    try {
      await reader.cancel();
    } catch {
      /* Diagnostic disposal cannot replace the result. */
    }
  };
  const cancel = () => {
    void discard();
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      // oxlint-disable-next-line no-await-in-loop -- Sequential reads bound and preserve provider bytes.
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > 65_536) {
        throw new Error("oversized_body");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
    void discard();
    reader.releaseLock();
  }
};

/** Read-only metadata observation. It never proves permission to create a project. */
export const inspectNativeTargetVercelAuthorization = async (input: {
  expectedInstallationId: string;
  expectedTeamId: string;
  /** Trusted owner-scoped private credential port; never persisted in the observation. */
  readInstallationToken: () => Promise<string | undefined>;
  fetch: typeof fetch;
  signal: AbortSignal;
}): Promise<NativeTargetVercelAuthorizationObservation> => {
  let statusCode: number | undefined;
  try {
    input.signal.throwIfAborted();
    const token = await input.readInstallationToken();
    input.signal.throwIfAborted();
    if (token === undefined || token.length === 0) {
      return { failure: "credential_unavailable", status: "unavailable" };
    }
    const url = new URL(
      `https://api.vercel.com/v1/integrations/configuration/${encodeURIComponent(input.expectedInstallationId)}`,
    );
    url.searchParams.set("teamId", input.expectedTeamId);
    const response = await input.fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      redirect: "error",
      signal: input.signal,
    });
    input.signal.throwIfAborted();
    statusCode = response.status;
    let body: unknown;
    try {
      body = JSON.parse(await readConfigurationJson(response, input.signal));
    } catch {
      return {
        failure: input.signal.aborted ? "cancelled" : "invalid_response",
        status: "unavailable",
        statusCode,
      };
    }
    input.signal.throwIfAborted();
    if (!response.ok) {
      const error = z.object({ error: z.object({ code: providerCode }) }).safeParse(body);
      return {
        failure: "provider_rejected",
        providerCode: error.success ? error.data.error.code : "unknown",
        status: "unavailable",
        statusCode,
      };
    }
    const parsed = configuration.safeParse(body);
    if (!parsed.success) {
      return { failure: "invalid_response", status: "unavailable", statusCode };
    }
    const value = parsed.data;
    return {
      allProjectsConfigured: value.projectSelection === "all",
      disabled:
        (value.disabledAt !== null && value.disabledAt !== undefined) ||
        (value.disabledReason !== null && value.disabledReason !== undefined),
      installationMatches: value.id === input.expectedInstallationId,
      ownerMatches: value.ownerId === input.expectedTeamId,
      projectWriteConfigured: value.scopes.includes("read-write:project"),
      status: "observed",
      statusCode,
      teamMatches: value.teamId === input.expectedTeamId,
    };
  } catch {
    const result = {
      failure: input.signal.aborted ? "cancelled" : "request_failed",
      status: "unavailable",
    } as const;
    if (statusCode !== undefined) {
      return { ...result, statusCode };
    }
    return result;
  }
};
