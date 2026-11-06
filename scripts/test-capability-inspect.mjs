/** @typedef {{ env: Record<string, string | undefined>, stdout: { write(value: string): boolean }, [key: symbol]: (() => unknown) | undefined }} RegistryProcess */
/** @type {RegistryProcess} */
const nodeProcess = /** @type {RegistryProcess} */ (globalThis.process);
const accessor =
  nodeProcess[Symbol.for("withAutograph.autograph-app-builder.test-capability-registry.v2")];
nodeProcess.stdout.write(
  JSON.stringify({
    capability: accessor?.() ?? null,
    nodeOptions: nodeProcess.env.NODE_OPTIONS ?? null,
  }),
);
