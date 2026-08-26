const accessor =
  process[
    Symbol.for(
      "withAutograph.autograph-app-builder.test-capability-registry.v2",
    )
  ];
process.stdout.write(
  JSON.stringify({
    capability: typeof accessor === "function" ? (accessor() ?? null) : null,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
  }),
);
