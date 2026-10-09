import { createHostedOperatorConsentDiagnostic } from "./hosted-operator-consent-diagnostic";
import type {
  HostedOperatorConsentDiagnosticSink,
  HostedOperatorConsentMetadata,
} from "./hosted-operator-consent-diagnostic";

export const operatorHeaderProbeRequired = (response: Response): boolean =>
  response.status === 403 &&
  response.headers.get("x-vercel-error") === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH";

const cancelBody = async (body: ReadableStream<Uint8Array> | null): Promise<void> => {
  try {
    await body?.cancel();
  } catch {
    /* Discarding a diagnostic body cannot replace the original denial. */
  }
};

const nativeNotFound = async (response: Response): Promise<boolean> => {
  if (response.status !== 404 || response.body === null) {
    return false;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Read a bounded response stream serially; parallel reads can reorder bytes.
      const result = await reader.read();
      if (result.done) {
        break;
      }
      size += result.value.byteLength;
      if (size > 128) {
        return false;
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes).trim() === '{"code":"not_found"}';
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Discarding a diagnostic body cannot replace the original denial. */
    }
    reader.releaseLock();
  }
};

/** Transport-only GETs retain the original caller token; no operator operation is submitted. */
export const reportHostedOperatorHeaderProbes = async (input: {
  fetch: typeof fetch;
  phase: HostedOperatorConsentMetadata["phase"];
  sessionId: string;
  signal?: AbortSignal;
  sink?: HostedOperatorConsentDiagnosticSink;
  token: string;
  url: URL;
}): Promise<void> => {
  const report = createHostedOperatorConsentDiagnostic(input.sessionId, input.sink);
  const probe = async (probeVariant: "both_headers" | "trusted_oidc_only") => {
    try {
      const headers = new Headers({ "x-vercel-trusted-oidc-idp-token": input.token });
      if (probeVariant === "both_headers") {
        headers.set("authorization", `Bearer ${input.token}`);
      }
      const signals = [AbortSignal.timeout(3000)];
      if (input.signal !== undefined) {
        signals.push(input.signal);
      }
      const response = await input.fetch(input.url, {
        headers,
        method: "GET",
        redirect: "error",
        signal: AbortSignal.any(signals),
      });
      const isNativeNotFound = await nativeNotFound(response);
      let outcome: HostedOperatorConsentMetadata["outcome"] = "setup_unavailable";
      if (isNativeNotFound) {
        outcome = "verified";
      } else if (response.status === 401 || response.status === 403) {
        outcome = "operator_access_denied";
      }
      const metadata: HostedOperatorConsentMetadata = {
        boundary: "builder",
        httpStatus: response.status,
        nativeNotFound: isNativeNotFound,
        outcome,
        phase: input.phase,
        probeVariant,
        stage: "operator_header_probe",
      };
      if (response.headers.get("x-vercel-error") === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH") {
        metadata.vercelError = "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH";
      }
      report(metadata);
      await cancelBody(response.body);
    } catch {
      report({
        boundary: "builder",
        outcome: "setup_unavailable",
        phase: input.phase,
        probeVariant,
        stage: "operator_header_probe",
      });
    }
  };
  await probe("both_headers");
  await probe("trusted_oidc_only");
};
