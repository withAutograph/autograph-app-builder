import { parentPort, workerData } from "node:worker_threads";

const accessor =
  process[
    Symbol.for(
      "withAutograph.autograph-app-builder.test-capability-registry.v2",
    )
  ];
const capability = typeof accessor === "function" ? (accessor() ?? null) : null;
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
if (workerData?.spawnNested === true) {
  const { Worker } = await import("node:worker_threads");
  const nested = new Worker(new URL(import.meta.url));
  const nestedResult = await new Promise((resolveMessage, reject) => {
    nested.once("message", resolveMessage);
    nested.once("error", reject);
  });
  nestedCapability = nestedResult.capability;
  nestedAppRoot = nestedResult.appRoot;
  nestedEveDev = nestedResult.eveDev;
  nestedWorkflowBodyTimeout = nestedResult.workflowBodyTimeout;
  nestedWorkflowHeadersTimeout = nestedResult.workflowHeadersTimeout;
  await nested.terminate();
}

parentPort?.postMessage({
  capability,
  appRoot: process.env.EVE_DEV_WORKER_APP_ROOT ?? null,
  eveDev: process.env.EVE_DEV ?? null,
  workflowBaseUrl: process.env.WORKFLOW_LOCAL_BASE_URL ?? null,
  workflowBodyTimeout: process.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS ?? null,
  workflowHeadersTimeout: process.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS ?? null,
  port: process.env.PORT ?? null,
  hasTransportSecret:
    process.env.EVE_DEV_WORKFLOW_TRANSPORT_SECRET !== undefined,
  sandboxRunId: process.env.EVE_DEVELOPMENT_SANDBOX_RUN_ID ?? null,
  evaluation: process.env.EVE_EVALUATION ?? null,
  evaluationRunId: process.env.EVE_EVALUATION_RUN_ID ?? null,
  hasGateAEnvironment: gateAFields.some(
    (field) => process.env[field] !== undefined,
  ),
  nestedCapability,
  nestedAppRoot,
  nestedEveDev,
  nestedWorkflowBodyTimeout,
  nestedWorkflowHeadersTimeout,
});
