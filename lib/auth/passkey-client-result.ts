type PasskeyClientError = {
  code?: unknown;
  message?: unknown;
};

const USER_MEDIATED_NO_ASSERTION_CODE = "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY";
// Better Auth also emits this code when verification transport fails after the
// browser returned an assertion, but omits the WebAuthn response in that path.
const AMBIGUOUS_ASSERTION_CODE = "AUTH_CANCELLED";

export type PasskeyAssertionStatus = "returned" | "not-returned" | "unknown";

export type PasskeyAuthenticationFailure = {
  assertionStatus: PasskeyAssertionStatus;
  code?: string;
  error: Error;
  offerSignUp: boolean;
};

export type PasskeyAuthenticationEvidence = {
  assertionReturned?: boolean;
  credentialUnavailable?: boolean;
  credentialError?: {
    name?: string;
    message?: string;
  };
};

function structuralCredentialError(error: unknown) {
  if (!error || typeof error !== "object") return {};
  const candidate = error as { name?: unknown; message?: unknown };
  return {
    ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
    ...(typeof candidate.message === "string"
      ? { message: candidate.message }
      : {}),
  };
}

function passkeyResultError(result: unknown): PasskeyClientError | null {
  if (!result || typeof result !== "object" || !("error" in result)) {
    return null;
  }

  const error = (result as { error?: PasskeyClientError | null }).error;
  return error && typeof error === "object" ? error : null;
}

export function passkeyClientError(result: unknown): Error | null {
  const error = passkeyResultError(result);
  if (!error) return null;

  const message =
    typeof error.message === "string" && error.message
      ? error.message
      : "Passkey authentication could not be completed.";
  const clientError = new Error(message);
  if (typeof error.code === "string") clientError.name = error.code;
  return clientError;
}

export function passkeyAuthenticationFailure(
  result: unknown,
  evidence: PasskeyAuthenticationEvidence = {},
): PasskeyAuthenticationFailure | null {
  const resultError = passkeyResultError(result);
  const error = passkeyClientError(result);
  if (!resultError || !error) return null;

  const responseIncludesAssertion =
    typeof result === "object" &&
    result !== null &&
    "webauthn" in result &&
    typeof result.webauthn === "object" &&
    result.webauthn !== null;
  const assertionStatus: PasskeyAssertionStatus =
    evidence.assertionReturned === true || responseIncludesAssertion
      ? "returned"
      : evidence.credentialError !== undefined ||
          evidence.credentialUnavailable === true
        ? "not-returned"
        : resultError.code === AMBIGUOUS_ASSERTION_CODE
          ? "unknown"
          : "not-returned";
  const resultCode =
    typeof resultError.code === "string" ? resultError.code : undefined;
  const userMediatedNoAssertion =
    assertionStatus === "not-returned" &&
    (evidence.credentialError?.name === "NotAllowedError" ||
      (evidence.credentialUnavailable === true &&
        resultCode === AMBIGUOUS_ASSERTION_CODE) ||
      (evidence.credentialError === undefined &&
        evidence.credentialUnavailable !== true &&
        resultCode === USER_MEDIATED_NO_ASSERTION_CODE));
  const code = userMediatedNoAssertion
    ? USER_MEDIATED_NO_ASSERTION_CODE
    : resultCode;
  const failureError = userMediatedNoAssertion
    ? Object.assign(
        new Error(evidence.credentialError?.message || error.message),
        { name: USER_MEDIATED_NO_ASSERTION_CODE },
      )
    : error;

  return {
    assertionStatus,
    ...(code ? { code } : {}),
    error: failureError,
    offerSignUp: userMediatedNoAssertion,
  };
}

export function createPasskeyAuthenticationBoundary() {
  const evidence: PasskeyAuthenticationEvidence = {};

  return {
    observeCredentialGet(credentials: CredentialsContainer | undefined) {
      if (!credentials || typeof credentials.get !== "function")
        return () => {};

      const ownDescriptor = Object.getOwnPropertyDescriptor(credentials, "get");
      const originalGet = credentials.get;
      const observedGet: CredentialsContainer["get"] = async (options) => {
        try {
          const credential = await originalGet.call(credentials, options);
          if (credential) evidence.assertionReturned = true;
          else evidence.credentialUnavailable = true;
          return credential;
        } catch (error) {
          evidence.credentialError = structuralCredentialError(error);
          throw error;
        }
      };

      Object.defineProperty(credentials, "get", {
        configurable: true,
        writable: true,
        value: observedGet,
      });

      return () => {
        if (ownDescriptor) {
          Object.defineProperty(credentials, "get", ownDescriptor);
        } else {
          Reflect.deleteProperty(credentials, "get");
        }
      };
    },
    failure(result: unknown) {
      const failure = passkeyAuthenticationFailure(result, evidence);
      if (failure) return failure;

      const thrown = structuralCredentialError(result);
      if (!thrown.name && !thrown.message) return null;
      return passkeyAuthenticationFailure(
        {
          error: {
            ...(thrown.name ? { code: thrown.name } : {}),
            message:
              thrown.message ||
              "Passkey authentication could not be completed.",
          },
        },
        evidence,
      );
    },
  };
}
