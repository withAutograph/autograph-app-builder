/* oxlint-disable anti-slop/no-runtime-typeof -- Preserve runtime input discrimination and existing fixture behavior. */
/// <reference types="node" />
import { parentPort, workerData } from "node:worker_threads";
import { once } from "node:events";

/**
 * @typedef {object} NestedWorkerResult
 * @property {unknown} capability Capability reported by the nested worker.
 * @property {string | null} appRoot Worker application root, if set.
 * @property {string | null} eveDev Eve development setting, if set.
 * @property {string | null} workflowBodyTimeout Workflow body timeout, if set.
 * @property {string | null} workflowHeadersTimeout Workflow headers timeout, if set.
 */

/** @param {unknown} value @returns {value is () => unknown} */
const isCapabilityAccessor = (value) => typeof value === "function";

// oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing assignment while its type remains unresolved.
const accessor =
  process[Symbol.for("withAutograph.autograph-app-builder.test-capability-registry.v2")];
/** @type {unknown} */
const capability = isCapabilityAccessor(accessor) ? (accessor() ?? null) : null;
const gateAFields = [
  "APP_BUILDER_LOCAL_PUBLICATION",
  "APP_BUILDER_BRANCH_WORKTREE_PUBLICATION",
  "APP_BUILDER_BRANCH_WORKTREE_ROOT",
  "APP_BUILDER_FRESH_BOOTSTRAP_ENABLED",
  "APP_BUILDER_FRESH_BOOTSTRAP_STATE_ROOT",
  "APP_BUILDER_FRESH_BOOTSTRAP_ALLOWED_ROOT",
  "APP_BUILDER_FRESH_BOOTSTRAP_EVAL_FAULT",
  "APP_BUILDER_REAL_SANDBOX",
  "APP_BUILDER_HOSTED_ARTIFACT_PROOF",
  "APP_BUILDER_SANDBOX_IMAGE",
  "APP_BUILDER_LOCAL_ADAPTER",
  "EVE_AGENT_HOST",
  "REPOSITORY_LOCAL_ROOTS",
  "REPOSITORY_WORKSPACE_ROOT",
];

let nestedCapability = null;
let nestedAppRoot = null;
let nestedEveDev = null;
let nestedWorkflowBodyTimeout = null;
let nestedWorkflowHeadersTimeout = null;
// oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing untyped input or fixture boundary.
if (workerData?.spawnNested === true) {
  const { Worker } = await import("node:worker_threads");
  const nested = new Worker(new URL(import.meta.url));
  /** @type {[NestedWorkerResult]} */
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
  const [nestedResult] = await once(nested, "message");
  nestedCapability = nestedResult.capability;
  nestedAppRoot = nestedResult.appRoot;
  nestedEveDev = nestedResult.eveDev;
  nestedWorkflowBodyTimeout = nestedResult.workflowBodyTimeout;
  nestedWorkflowHeadersTimeout = nestedResult.workflowHeadersTimeout;
  await nested.terminate();
}

// Node worker_threads MessagePorts do not accept a browser targetOrigin.
// oxlint-disable unicorn/require-post-message-target-origin
parentPort?.postMessage({
  appRoot: process.env.EVE_DEV_WORKER_APP_ROOT ?? null,
  capability,
  evaluation: process.env.EVE_EVALUATION ?? null,
  evaluationRunId: process.env.EVE_EVALUATION_RUN_ID ?? null,
  eveDev: process.env.EVE_DEV ?? null,
  hasGateAEnvironment: gateAFields.some((field) => process.env[field] !== undefined),
  hasTransportSecret: process.env.EVE_DEV_WORKFLOW_TRANSPORT_SECRET !== undefined,
  nestedAppRoot,
  nestedCapability,
  nestedEveDev,
  nestedWorkflowBodyTimeout,
  nestedWorkflowHeadersTimeout,
  port: process.env.PORT ?? null,
  sandboxRunId: process.env.EVE_DEVELOPMENT_SANDBOX_RUN_ID ?? null,
  workflowBaseUrl: process.env.WORKFLOW_LOCAL_BASE_URL ?? null,
  workflowBodyTimeout: process.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS ?? null,
  workflowHeadersTimeout: process.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS ?? null,
});
// oxlint-enable unicorn/require-post-message-target-origin
