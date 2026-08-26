import { parentPort, workerData } from "node:worker_threads";

const accessor =
  process[
    Symbol.for(
      "withAutograph.autograph-app-builder.test-capability-registry.v2",
    )
  ];
const capability = typeof accessor === "function" ? (accessor() ?? null) : null;

let nestedCapability = null;
if (workerData?.spawnNested === true) {
  const { Worker } = await import("node:worker_threads");
  const nested = new Worker(new URL(import.meta.url));
  nestedCapability = await new Promise((resolveMessage, reject) => {
    nested.once("message", (message) => resolveMessage(message.capability));
    nested.once("error", reject);
  });
  await nested.terminate();
}

parentPort?.postMessage({
  capability,
  nestedCapability,
});
