/** @typedef {{ spawnNested?: boolean }} WorkerInput */
/** @typedef {{ env: Record<string, string | undefined>, [key: symbol]: (() => unknown) | undefined }} RegistryProcess */
/** @typedef {{ appRoot: string | null, capability: unknown, eveDev: string | null, workflowBodyTimeout: string | null, workflowHeadersTimeout: string | null }} NestedWorkerMessage */
/** @typedef {{ Worker: new (url: URL) => { once: (event: string, callback: (message: NestedWorkerMessage) => void) => void, terminate: () => Promise<number> }, parentPort: { postMessage: (message: WorkerMessage) => void } | null, workerData: unknown }} WorkerThreadModule */
/** @typedef {{ env: Record<string, string | undefined>, [key: symbol]: (() => unknown) | undefined }} ProcessModule */
/** @type {(specifier: string) => Promise<unknown>} */
const loadModule = async (specifier) => await import(specifier);
const processModule = await loadModule("node:process");
const workerThreadsModule = await loadModule("node:worker_threads");
/** @type {ProcessModule} */
const processApi = processModule;
/** @type {WorkerThreadModule} */
const workerThreads = workerThreadsModule;
/** @type {RegistryProcess} */
const nodeProcess = processApi;
const registryKey = Symbol.for("withAutograph.autograph-app-builder.test-capability-registry.v2");
/** @type {(() => unknown) | undefined} */
const accessor = nodeProcess[registryKey];
const capability = accessor?.() ?? null;
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
const parsedWorkerData = workerThreads.workerData;
if (parsedWorkerData?.spawnNested === true) {
  const nested = new workerThreads.Worker(new URL(import.meta.url));
  const nestedResult = await new PromiseWithResolvers();
  nestedCapability = nestedResult.capability;
  nestedAppRoot = nestedResult.appRoot;
  nestedEveDev = nestedResult.eveDev;
  nestedWorkflowBodyTimeout = nestedResult.workflowBodyTimeout;
  nestedWorkflowHeadersTimeout = nestedResult.workflowHeadersTimeout;
  await nested.terminate();
}

/** @typedef {{ appRoot: string | null, capability: unknown, evaluation: string | null, evaluationRunId: string | null, eveDev: string | null, hasGateAEnvironment: boolean, hasTransportSecret: boolean, nestedAppRoot: string | null, nestedCapability: unknown, nestedEveDev: string | null, nestedWorkflowBodyTimeout: string | null, nestedWorkflowHeadersTimeout: string | null, port: string | null, sandboxRunId: string | null, workflowBaseUrl: string | null, workflowBodyTimeout: string | null, workflowHeadersTimeout: string | null }} WorkerMessage */
/** @type {WorkerMessage} */
const message = {
  appRoot: nodeProcess.env.EVE_DEV_WORKER_APP_ROOT ?? null,
  capability,
  evaluation: nodeProcess.env.EVE_EVALUATION ?? null,
  evaluationRunId: nodeProcess.env.EVE_EVALUATION_RUN_ID ?? null,
  eveDev: nodeProcess.env.EVE_DEV ?? null,
  hasGateAEnvironment: gateAFields.some((field) => nodeProcess.env[field] !== undefined),
  hasTransportSecret: nodeProcess.env.EVE_DEV_WORKFLOW_TRANSPORT_SECRET !== undefined,
  nestedAppRoot,
  nestedCapability,
  nestedEveDev,
  nestedWorkflowBodyTimeout,
  nestedWorkflowHeadersTimeout,
  port: nodeProcess.env.PORT ?? null,
  sandboxRunId: nodeProcess.env.EVE_DEVELOPMENT_SANDBOX_RUN_ID ?? null,
  workflowBaseUrl: nodeProcess.env.WORKFLOW_LOCAL_BASE_URL ?? null,
  workflowBodyTimeout: nodeProcess.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS ?? null,
  workflowHeadersTimeout: nodeProcess.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS ?? null,
};
/* Node worker_threads MessagePorts do not accept a browser targetOrigin. */
workerThreads.parentPort?.postMessage(message);
