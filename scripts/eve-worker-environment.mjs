import { isIP } from "node:net";

export const eveWorkerEnvelopeKey =
  "__appBuilderAuthorizedEveWorkerEnvironmentV1";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const transportSecretPattern = /^[A-Za-z0-9_-]{43}$/u;

function fail(field) {
  throw new Error(`The trusted Eve worker ${field} was invalid.`);
}

function validLoopbackHostname(hostname) {
  const normalized = hostname.startsWith("[")
    ? hostname.slice(1, -1)
    : hostname;
  if (normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split(".")[0] === "127";
}

function validateBaseUrl(value) {
  if (typeof value !== "string") fail("base URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("base URL");
  }
  if (
    url.protocol !== "http:" ||
    !validLoopbackHostname(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port === "" ||
    url.origin !== value
  )
    fail("base URL");
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("port");
  return { baseUrl: url.origin, port: String(port) };
}

function validateUuid(value, field, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !uuidPattern.test(value)) fail(field);
  return value;
}

function validateTransportSecret(value) {
  if (
    typeof value !== "string" ||
    !transportSecretPattern.test(value) ||
    Buffer.from(value, "base64url").byteLength !== 32 ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  )
    fail("transport secret");
  return value;
}

function validateBodyTimeout(value) {
  if (value === undefined) return undefined;
  if (value !== "360000") fail("body timeout");
  return value;
}

export function captureEveWorkerEnvelope(source, expectedAppRoot) {
  if (source === undefined || source === null) fail("explicit environment");
  if (source.EVE_DEV !== "1") fail("development marker");
  if (source.EVE_DEV_WORKER_APP_ROOT !== expectedAppRoot) fail("app root");
  const { baseUrl, port } = validateBaseUrl(source.WORKFLOW_LOCAL_BASE_URL);
  if (source.PORT !== port) fail("port");
  if (source.EVE_EVALUATION !== "1") fail("evaluation marker");
  return Object.freeze({
    version: 1,
    appRoot: expectedAppRoot,
    baseUrl,
    port,
    transportSecret: validateTransportSecret(
      source.EVE_DEV_WORKFLOW_TRANSPORT_SECRET,
    ),
    developmentSandboxRunId: validateUuid(
      source.EVE_DEVELOPMENT_SANDBOX_RUN_ID,
      "sandbox run id",
      true,
    ),
    evaluationRunId: validateUuid(
      source.EVE_EVALUATION_RUN_ID,
      "evaluation run id",
    ),
    bodyTimeout: validateBodyTimeout(
      source.WORKFLOW_LOCAL_BODY_TIMEOUT_MS,
    ),
  });
}

export function installEveWorkerEnvelope(environment, value, expectedAppRoot) {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).sort().join(",") !==
      [
        "appRoot",
        "baseUrl",
        "bodyTimeout",
        "developmentSandboxRunId",
        "evaluationRunId",
        "port",
        "transportSecret",
        "version",
      ]
        .sort()
        .join(",") ||
    value.version !== 1 ||
    value.appRoot !== expectedAppRoot
  )
    fail("envelope");
  const captured = captureEveWorkerEnvelope(
    {
      EVE_DEV: "1",
      EVE_DEV_WORKER_APP_ROOT: value.appRoot,
      WORKFLOW_LOCAL_BASE_URL: value.baseUrl,
      PORT: value.port,
      EVE_DEV_WORKFLOW_TRANSPORT_SECRET: value.transportSecret,
      EVE_DEVELOPMENT_SANDBOX_RUN_ID: value.developmentSandboxRunId,
      EVE_EVALUATION: "1",
      EVE_EVALUATION_RUN_ID: value.evaluationRunId,
      WORKFLOW_LOCAL_BODY_TIMEOUT_MS: value.bodyTimeout,
    },
    expectedAppRoot,
  );
  environment.EVE_DEV = "1";
  environment.EVE_DEV_WORKER_APP_ROOT = captured.appRoot;
  environment.WORKFLOW_LOCAL_BASE_URL = captured.baseUrl;
  environment.PORT = captured.port;
  environment.EVE_DEV_WORKFLOW_TRANSPORT_SECRET = captured.transportSecret;
  if (captured.developmentSandboxRunId === undefined)
    delete environment.EVE_DEVELOPMENT_SANDBOX_RUN_ID;
  else
    environment.EVE_DEVELOPMENT_SANDBOX_RUN_ID =
      captured.developmentSandboxRunId;
  environment.EVE_EVALUATION = "1";
  environment.EVE_EVALUATION_RUN_ID = captured.evaluationRunId;
  if (captured.bodyTimeout === undefined)
    delete environment.WORKFLOW_LOCAL_BODY_TIMEOUT_MS;
  else environment.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = captured.bodyTimeout;
}
