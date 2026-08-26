import { parentPort, workerData } from "node:worker_threads";

const accessor =
  process[
    Symbol.for(
      "withAutograph.autograph-app-builder.test-capability-registry.v2",
    )
  ];
const capability = typeof accessor === "function" ? (accessor() ?? null) : null;

let nestedCapability = null;
let nestedAppRoot = null;
let nestedEveDev = null;
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
  await nested.terminate();
}

parentPort?.postMessage({
  capability,
  appRoot: process.env.EVE_DEV_WORKER_APP_ROOT ?? null,
  eveDev: process.env.EVE_DEV ?? null,
  nestedCapability,
  nestedAppRoot,
  nestedEveDev,
});
