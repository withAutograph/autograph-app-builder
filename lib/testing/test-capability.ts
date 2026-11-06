const MOCK_MODEL = "mock-model";
const CAPABILITY_KEYS = "capabilities,id,version";

export const TEST_CAPABILITIES = [MOCK_MODEL, "simulated-target", "simulated-publication"] as const;

export type TestCapability = (typeof TEST_CAPABILITIES)[number];

const registryAccessor = Symbol.for(
  "withAutograph.autograph-app-builder.test-capability-registry.v2",
);

export type InjectedTestCapability = Readonly<{
  version: 1;
  id: string;
  capabilities: readonly TestCapability[];
}>;

const exactCapabilities = (value: readonly TestCapability[]): boolean =>
  new Set(value).size === value.length && value.every((entry) => TEST_CAPABILITIES.includes(entry));

const isInjectedTestCapability = (value: InjectedTestCapability): boolean => {
  if (!Object.isFrozen(value)) return false;
  if (Object.keys(value).toSorted().join(",") !== CAPABILITY_KEYS) return false;
  if (value.version !== 1) return false;
  if (!/^[0-9a-f]{64}$/u.test(value.id)) return false;
  if (!exactCapabilities(value.capabilities)) return false;
  return Object.isFrozen(value.capabilities);
};

export function testCapabilityEnabled(
  capability: TestCapability,
  environment: Readonly<Record<string, string | undefined>>,
  injected: InjectedTestCapability | undefined,
): boolean {
  if (capability === MOCK_MODEL && environment.APP_BUILDER_TEST_MODEL !== "1") {
    return false;
  }
  if (environment.APP_BUILDER_REAL_SANDBOX === "1" && capability !== MOCK_MODEL) {
    return false;
  }
  if (injected === undefined || !isInjectedTestCapability(injected)) return false;
  if (environment.APP_BUILDER_TEST_CAPABILITY_ID !== injected.id) return false;
  return injected.capabilities.includes(capability);
}

type TestCapabilityAccessor = () => InjectedTestCapability | undefined;

interface CapabilityCandidate {
  readonly capabilities?: unknown;
  readonly id?: unknown;
  readonly version?: unknown;
}

const hasCapabilityKeys = (value: CapabilityCandidate): boolean =>
  Object.keys(value).toSorted().join(",") === CAPABILITY_KEYS;

const isCapabilityId = (value: CapabilityCandidate["id"]): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);

const isTestCapability = (value: string): value is TestCapability =>
  TEST_CAPABILITIES.some((capability) => capability === value);

const parseInjectedTestCapability = (
  value: CapabilityCandidate,
): InjectedTestCapability | undefined => {
  if (Array.isArray(value)) return undefined;
  if (!Object.isFrozen(value) || !hasCapabilityKeys(value)) return undefined;
  const { version, id, capabilities } = value;
  if (version !== 1 || !isCapabilityId(id)) return undefined;
  if (!Array.isArray(capabilities) || !capabilities.every(isTestCapability)) {
    return undefined;
  }
  if (!Object.isFrozen(capabilities)) return undefined;
  return {
    capabilities,
    id,
    version: 1,
  };
};

const parseTestCapabilityAccessor =
  (accessor: TestCapabilityAccessor): TestCapabilityAccessor =>
  () =>
    parseInjectedTestCapability(accessor());

const readRegistryAccessor = (
  processObject: NodeJS.Process,
): TestCapabilityAccessor | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(processObject, registryAccessor);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  const value: unknown = descriptor.value;
  if (typeof value !== "function") return undefined;
  return parseTestCapabilityAccessor(value as TestCapabilityAccessor);
};

export function hasTestCapability(
  capability: TestCapability,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const accessor = readRegistryAccessor(process);
  return testCapabilityEnabled(capability, environment, accessor?.());
}
