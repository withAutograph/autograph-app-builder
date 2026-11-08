/** @param {unknown} value @returns {value is () => unknown} */
const isCapabilityAccessor = (value) => typeof value === "function";

const accessor =
  process[Symbol.for("withAutograph.autograph-app-builder.test-capability-registry.v2")];
process.stdout.write(
  JSON.stringify({
    capability: isCapabilityAccessor(accessor) ? (accessor() ?? null) : null,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
  }),
);
