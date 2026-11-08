const mockModelCapability = "mock-model";

export const TEST_CAPABILITIES = [
  mockModelCapability,
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

const exactCapabilities = (value: unknown): value is readonly TestCapability[] =>
  Array.isArray(value) &&
  new Set(value).size === value.length &&
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing type assertion at this boundary.
  value.every((entry) => TEST_CAPABILITIES.includes(entry as TestCapability));

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function testCapabilityEnabled(
  capability: TestCapability,
  environment: Readonly<Record<string, string | undefined>>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
  injected: unknown,
): boolean {
  if (capability === mockModelCapability && environment.APP_BUILDER_TEST_MODEL !== "1") {
    return false;
  }
  if (environment.APP_BUILDER_REAL_SANDBOX === "1" && capability !== mockModelCapability) {
    return false;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof injected !== "object" || injected === null) {
    return false;
  }
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing type assertion at this boundary.
  const candidate = injected as Partial<InjectedTestCapability>;
  if (
    !Object.isFrozen(candidate) ||
    Object.keys(candidate).toSorted().join(",") !== "capabilities,id,version" ||
    candidate.version !== 1 ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    typeof candidate.id !== "string"
  ) {
    return false;
  }
  if (
    !/^[0-9a-f]{64}$/u.test(candidate.id) ||
    environment.APP_BUILDER_TEST_CAPABILITY_ID !== candidate.id ||
    !exactCapabilities(candidate.capabilities)
  ) {
    return false;
  }
  return Object.isFrozen(candidate.capabilities) && candidate.capabilities.includes(capability);
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- The capability accessor can return arbitrary stored data.
const isCapabilityAccessor = (value: unknown): value is () => unknown =>
  typeof value === "function";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function hasTestCapability(
  capability: TestCapability,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- The shared symbol registry is attached to process outside its declared type.; Preserve the existing open-ended value contract.; Preserve the existing type assertion at this boundary.
  const accessor = (process as unknown as Record<symbol, unknown>)[registryAccessor];
  return testCapabilityEnabled(
    capability,
    environment,
    isCapabilityAccessor(accessor) ? accessor() : undefined,
  );
}
