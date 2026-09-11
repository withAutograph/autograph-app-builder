export const TEST_CAPABILITIES = [
  "mock-model",
  "simulated-target",
  "simulated-publication",
] as const;

export type TestCapability = (typeof TEST_CAPABILITIES)[number];

const registryAccessor = Symbol.for(
  "withAutograph.autograph-app-builder.test-capability-registry.v2",
);

export type InjectedTestCapability = Readonly<{
  version: 1;
  id: string;
  capabilities: readonly TestCapability[];
}>;

const exactCapabilities = (
  value: unknown,
): value is readonly TestCapability[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  new Set(value).size === value.length &&
  value.every((entry) => TEST_CAPABILITIES.includes(entry as TestCapability));

export function testCapabilityEnabled(
  capability: TestCapability,
  environment: Readonly<Record<string, string | undefined>>,
  injected: unknown,
): boolean {
  if (capability === "mock-model" && environment.APP_BUILDER_TEST_MODEL !== "1")
    return false;
  if (
    environment.APP_BUILDER_REAL_SANDBOX === "1" &&
    capability !== "mock-model"
  )
    return false;
  if (typeof injected !== "object" || injected === null) return false;
  const candidate = injected as Partial<InjectedTestCapability>;
  return (
    Object.isFrozen(candidate) &&
    Object.keys(candidate).sort().join(",") === "capabilities,id,version" &&
    candidate.version === 1 &&
    typeof candidate.id === "string" &&
    /^[0-9a-f]{64}$/u.test(candidate.id) &&
    environment.APP_BUILDER_TEST_CAPABILITY_ID === candidate.id &&
    exactCapabilities(candidate.capabilities) &&
    Object.isFrozen(candidate.capabilities) &&
    candidate.capabilities.includes(capability)
  );
}

export function hasTestCapability(
  capability: TestCapability,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const accessor = (process as unknown as Record<symbol, unknown>)[
    registryAccessor
  ];
  return testCapabilityEnabled(
    capability,
    environment,
    typeof accessor === "function" ? accessor() : undefined,
  );
}
