import { z } from "zod";

export const eveWorkerEnvelopeKey = "__appBuilderAuthorizedEveWorkerEnvironmentV1";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const transportSecretPattern = /^[A-Za-z0-9_-]{43}$/u;

/** @typedef {{ EVE_DEV?: string, EVE_DEVELOPMENT_SANDBOX_RUN_ID?: string | null, EVE_DEV_WORKER_APP_ROOT?: string, EVE_DEV_WORKFLOW_TRANSPORT_SECRET?: string, EVE_EVALUATION?: string, EVE_EVALUATION_RUN_ID?: string, PORT?: string, WORKFLOW_LOCAL_BASE_URL?: string, WORKFLOW_LOCAL_BODY_TIMEOUT_MS?: string | null, WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS?: string | null }} EveEnvironmentInput */
/** @typedef {{ EVE_DEV?: string, EVE_DEVELOPMENT_SANDBOX_RUN_ID?: string, EVE_DEV_WORKER_APP_ROOT?: string, EVE_DEV_WORKFLOW_TRANSPORT_SECRET?: string, EVE_EVALUATION?: string, EVE_EVALUATION_RUN_ID?: string, PORT?: string, WORKFLOW_LOCAL_BASE_URL?: string, WORKFLOW_LOCAL_BODY_TIMEOUT_MS?: string, WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS?: string }} EveEnvironment */
/** @typedef {{ appRoot: string, baseUrl: string, bodyTimeout: string | undefined, developmentSandboxRunId: string | undefined, evaluationRunId: string, headersTimeout: string | undefined, port: string, transportSecret: string, version: 1 }} EveEnvelope */
/** @typedef {{ baseUrl: string, port: string }} ValidatedBaseUrl */
/** @typedef {{ value: string | null }} OptionalValidatedValue */
/** @typedef {Record<string, string | undefined>} MutableEnvironment */

/** @param {string} field - Description of the invalid field. @returns {never} */
const fail = (field) => {
  throw new Error(`The trusted Eve worker ${field} was invalid.`);
};

/** @param {string} hostname - Hostname to check. */
const validLoopbackHostname = (hostname) => {
  const normalized = hostname.replaceAll(/^\[|\]$/gu, "");
  if (normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".");
  if (
    octets.length !== 4 ||
    octets.some((octet) => !/^(?:0|[1-9]\d{0,2})$/u.test(octet) || Number(octet) > 255)
  ) {
    return false;
  }
  return octets[0] === "127";
};

/** @param {string} value - URL to validate. @returns {ValidatedBaseUrl} */
const validateBaseUrl = (value) => {
  /** @type {URL | undefined} */
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("base URL");
  }
  const validOrigin = url.protocol === "http:" && url.origin === value;
  const validHost = validLoopbackHostname(url.hostname) && url.username === "";
  const validPath = url.password === "" && url.pathname === "/" && url.search === "";
  if (!validOrigin || !validHost || !validPath) {
    fail("base URL");
  }
  if (url.hash !== "" || url.port === "") {
    fail("base URL");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail("port");
  }
  return { baseUrl: url.origin, port: String(port) };
};

/** @param {string | undefined} value - UUID to validate. @param {string} field - Field name for errors. @param {boolean} [optional] - Whether absence is allowed. @returns {OptionalValidatedValue} */
const validateUuid = (value, field, optional = false) => {
  if (value === undefined && optional) return { value: null };
  if (value === undefined) fail(field);
  if (!uuidPattern.test(value)) {
    fail(field);
  }
  return { value };
};

/** @param {string} value - Secret to validate. @returns {string} */
const validateTransportSecret = (value) => {
  const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  if (
    !transportSecretPattern.test(value) ||
    decoded.length !== 32 ||
    btoa(decoded).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") !== value
  ) {
    fail("transport secret");
  }
  return value;
};

/** @param {string | undefined} value - Timeout to validate. @param {string} field - Field name for errors. @returns {OptionalValidatedValue} */
const validateWorkflowTimeout = (value, field) => {
  if (value === undefined) return { value: null };
  // Eve 0.68 explicitly sets zero for its default unbounded local delivery.
  if (value !== "0" && value !== "360000") {
    fail(field);
  }
  return { value };
};

/** @param {EveEnvironmentInput} source - Explicit environment input. @param {string} expectedAppRoot - Expected app root. @returns {Readonly<EveEnvelope>} */
export const captureEveWorkerEnvelope = (source, expectedAppRoot) => {
  const environment = source;
  if (environment.EVE_DEV !== "1") {
    fail("development marker");
  }
  if (environment.EVE_DEV_WORKER_APP_ROOT !== expectedAppRoot) {
    fail("app root");
  }
  const { baseUrl, port } = validateBaseUrl(environment.WORKFLOW_LOCAL_BASE_URL);
  if (environment.PORT !== port) {
    fail("port");
  }
  if (environment.EVE_EVALUATION !== "1") {
    fail("evaluation marker");
  }
  const { value: bodyTimeoutValue } = validateWorkflowTimeout(
    environment.WORKFLOW_LOCAL_BODY_TIMEOUT_MS ?? undefined,
    "body timeout",
  );
  const { value: developmentSandboxRunIdValue } = validateUuid(
    environment.EVE_DEVELOPMENT_SANDBOX_RUN_ID ?? undefined,
    "sandbox run id",
    true,
  );
  const { value: evaluationRunIdValue } = validateUuid(
    environment.EVE_EVALUATION_RUN_ID,
    "evaluation run id",
  );
  const { value: headersTimeoutValue } = validateWorkflowTimeout(
    environment.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS ?? undefined,
    "headers timeout",
  );
  const transportSecret = validateTransportSecret(environment.EVE_DEV_WORKFLOW_TRANSPORT_SECRET);
  const bodyTimeout = bodyTimeoutValue ?? undefined;
  const developmentSandboxRunId = developmentSandboxRunIdValue ?? undefined;
  const evaluationRunId = evaluationRunIdValue ?? fail("evaluation run id");
  const headersTimeout = headersTimeoutValue ?? undefined;
  return Object.freeze({
    appRoot: expectedAppRoot,
    baseUrl,
    bodyTimeout,
    developmentSandboxRunId,
    evaluationRunId,
    headersTimeout,
    port,
    transportSecret,
    version: 1,
  });
};

const envelopeSchema = z.strictObject({
  appRoot: z.string(),
  baseUrl: z.string(),
  bodyTimeout: z.string().optional(),
  developmentSandboxRunId: z.string().optional(),
  evaluationRunId: z.string(),
  headersTimeout: z.string().optional(),
  port: z.string(),
  transportSecret: z.string(),
  version: z.literal(1),
});

/** @param {unknown} value @returns {EveEnvelope} */
const parseEveEnvelope = (value) => {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) fail("envelope");
  return parsed.data;
};

/** @param {MutableEnvironment} environment - Target environment. @param {unknown} value - Captured envelope. @param {string} expectedAppRoot - Expected app root. */
export const installEveWorkerEnvelope = (environment, value, expectedAppRoot) => {
  const envelope = parseEveEnvelope(value);
  if (envelope.appRoot !== expectedAppRoot) {
    fail("envelope");
  }
  const captured = captureEveWorkerEnvelope(
    {
      EVE_DEV: "1",
      EVE_DEVELOPMENT_SANDBOX_RUN_ID: envelope.developmentSandboxRunId,
      EVE_DEV_WORKER_APP_ROOT: envelope.appRoot,
      EVE_DEV_WORKFLOW_TRANSPORT_SECRET: envelope.transportSecret,
      EVE_EVALUATION: "1",
      EVE_EVALUATION_RUN_ID: envelope.evaluationRunId,
      PORT: envelope.port,
      WORKFLOW_LOCAL_BASE_URL: envelope.baseUrl,
      WORKFLOW_LOCAL_BODY_TIMEOUT_MS: envelope.bodyTimeout,
      WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS: envelope.headersTimeout,
    },
    expectedAppRoot,
  );
  environment.EVE_DEV = "1";
  environment.EVE_DEV_WORKER_APP_ROOT = captured.appRoot;
  environment.WORKFLOW_LOCAL_BASE_URL = captured.baseUrl;
  environment.PORT = captured.port;
  environment.EVE_DEV_WORKFLOW_TRANSPORT_SECRET = captured.transportSecret;
  if (captured.developmentSandboxRunId === undefined) {
    delete environment.EVE_DEVELOPMENT_SANDBOX_RUN_ID;
  } else {
    environment.EVE_DEVELOPMENT_SANDBOX_RUN_ID = captured.developmentSandboxRunId;
  }
  environment.EVE_EVALUATION = "1";
  environment.EVE_EVALUATION_RUN_ID = captured.evaluationRunId;
  if (captured.bodyTimeout === undefined) {
    delete environment.WORKFLOW_LOCAL_BODY_TIMEOUT_MS;
  } else {
    environment.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = captured.bodyTimeout;
  }
  if (captured.headersTimeout === undefined) {
    delete environment.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS;
  } else {
    environment.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS = captured.headersTimeout;
  }
};
