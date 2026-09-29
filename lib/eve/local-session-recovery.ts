import type { ClientError } from "eve/client";

export const localSessionRecoveryError = {
  code: "session_recovery_unavailable",
  message:
    "Builder cannot recover this local Eve session from the current worker. Keep the original sessionId, clientRequestId, cursor and transcript. An operator must restore the original development workflow state or report this run as blocked; do not start a replacement request.",
} as const;

export class LocalSessionRecoveryUnavailableError extends Error {
  constructor() {
    super(localSessionRecoveryError.message);
    this.name = "LocalSessionRecoveryUnavailableError";
  }
}

/** Eve rejects these operations before accepting a new turn. */
export const isUnavailableLocalSession = (error: ClientError): boolean => {
  if (error.status === 404) {
    return true;
  }
  return error.status === 409 && error.code === "session_not_active";
};
