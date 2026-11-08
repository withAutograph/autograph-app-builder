/// <reference types="node" />
/// <reference lib="es2023.array" />

import { isIP } from "node:net";

/** @typedef {{ appRoot: string, baseUrl: string, bodyTimeout: string | undefined, developmentSandboxRunId: string | undefined, evaluationRunId: string, headersTimeout: string | undefined, port: string, transportSecret: string, version: 1 }} EveWorkerEnvelope */
/** @typedef {{ [key: string]: unknown }} UnknownRecord */

/** @param {unknown} value @returns {value is UnknownRecord} */
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
const isRecord = (value) => typeof value === "object" && value !== null;

export const eveWorkerEnvelopeKey = "__appBuilderAuthorizedEveWorkerEnvironmentV1";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const transportSecretPattern = /^[A-Za-z0-9_-]{43}$/u;

/** @param {string} field @returns {never} */
const fail = (field) => {
  throw new Error(`The trusted Eve worker ${field} was invalid.`);
};

/** @param {string} hostname - Hostname to check for a loopback address. */
const validLoopbackHostname = (hostname) => {
  const normalized = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (normalized === "::1") {
    return true;
  }
  if (isIP(normalized) !== 4) {
    return false;
  }
  return normalized.split(".")[0] === "127";
};

/** @param {unknown} value - Candidate local workflow URL. */
const validateBaseUrl = (value) => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof value !== "string") {
    fail("base URL");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("base URL");
  }
  if (url.protocol !== "http:") {
    fail("base URL");
  }
  if (!validLoopbackHostname(url.hostname)) {
    fail("base URL");
  }
  if (url.username !== "") {
    fail("base URL");
  }
  if (url.password !== "") {
    fail("base URL");
  }
  if (url.pathname !== "/") {
    fail("base URL");
  }
  if (url.search !== "") {
    fail("base URL");
  }
  if (url.hash !== "") {
    fail("base URL");
  }
  if (url.port === "") {
    fail("base URL");
  }
  if (url.origin !== value) {
    fail("base URL");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail("port");
  }
  return { baseUrl: url.origin, port: String(port) };
};

/** @param {unknown} value @param {string} field @param {boolean} [optional] */
const validateUuid = (value, field, optional = false) => {
  if (
    !(value === undefined && optional) &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    (typeof value !== "string" || !uuidPattern.test(value))
  ) {
    fail(field);
  }
  return value;
};

/** @param {unknown} value - Candidate transport secret. */
const validateTransportSecret = (value) => {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    typeof value !== "string" ||
    !transportSecretPattern.test(value) ||
    Buffer.from(value, "base64url").byteLength !== 32 ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  ) {
    fail("transport secret");
  }
  return value;
};

/** @param {unknown} value @param {string} field */
const validateWorkflowTimeout = (value, field) => {
  // Eve 0.68 explicitly sets zero for its default unbounded local delivery.
  if (value !== undefined && value !== "0" && value !== "360000") {
    fail(field);
  }
  return value;
};

/** @param {UnknownRecord | null | undefined} source @param {string} expectedAppRoot */
export const captureEveWorkerEnvelope = (source, expectedAppRoot) => {
  if (source === undefined || source === null) {
    fail("explicit environment");
  }
  if (source.EVE_DEV !== "1") {
    fail("development marker");
  }
  if (source.EVE_DEV_WORKER_APP_ROOT !== expectedAppRoot) {
    fail("app root");
  }
  const { baseUrl, port } = validateBaseUrl(source.WORKFLOW_LOCAL_BASE_URL);
  if (source.PORT !== port) {
    fail("port");
  }
  if (source.EVE_EVALUATION !== "1") {
    fail("evaluation marker");
  }
  return Object.freeze({
    appRoot: expectedAppRoot,
    baseUrl,
    bodyTimeout: validateWorkflowTimeout(source.WORKFLOW_LOCAL_BODY_TIMEOUT_MS, "body timeout"),
    developmentSandboxRunId: validateUuid(
      source.EVE_DEVELOPMENT_SANDBOX_RUN_ID,
      "sandbox run id",
      true,
    ),
    evaluationRunId: validateUuid(source.EVE_EVALUATION_RUN_ID, "evaluation run id"),
    headersTimeout: validateWorkflowTimeout(
      source.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS,
      "headers timeout",
    ),
    port,
    transportSecret: validateTransportSecret(source.EVE_DEV_WORKFLOW_TRANSPORT_SECRET),
    version: 1,
  });
};

/** @param {Record<string, string | undefined>} environment @param {unknown} value @param {string} expectedAppRoot */
export const installEveWorkerEnvelope = (environment, value, expectedAppRoot) => {
  if (!isRecord(value)) {
    fail("envelope");
  }
  const expectedKeys = [
    "appRoot",
    "baseUrl",
    "bodyTimeout",
    "developmentSandboxRunId",
    "evaluationRunId",
    "headersTimeout",
    "port",
    "transportSecret",
    "version",
  ];
  if (Object.keys(value).toSorted().join(",") !== expectedKeys.toSorted().join(",")) {
    fail("envelope");
  }
  if (value.version !== 1) {
    fail("envelope");
  }
  if (value.appRoot !== expectedAppRoot) {
    fail("envelope");
  }
  const captured = captureEveWorkerEnvelope(
    {
      EVE_DEV: "1",
      EVE_DEVELOPMENT_SANDBOX_RUN_ID: value.developmentSandboxRunId,
      EVE_DEV_WORKER_APP_ROOT: value.appRoot,
      EVE_DEV_WORKFLOW_TRANSPORT_SECRET: value.transportSecret,
      EVE_EVALUATION: "1",
      EVE_EVALUATION_RUN_ID: value.evaluationRunId,
      PORT: value.port,
      WORKFLOW_LOCAL_BASE_URL: value.baseUrl,
      WORKFLOW_LOCAL_BODY_TIMEOUT_MS: value.bodyTimeout,
      WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS: value.headersTimeout,
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
