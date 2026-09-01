import { createVercelAdapter } from "@flags-sdk/vercel";
import type { Adapter } from "flags";
import { flag } from "flags/next";

const booleanOptions = [
  { value: false, label: "Disabled" },
  { value: true, label: "Enabled" },
];

function failClosedAdapter<ValueType, EntitiesType>(): Adapter<
  ValueType,
  EntitiesType
> {
  return {
    async decide() {
      throw new Error("Vercel Flags is unavailable");
    },
  };
}

function managedVercelAdapter<ValueType, EntitiesType>(): Adapter<
  ValueType,
  EntitiesType
> {
  let adapter: Adapter<ValueType, EntitiesType> | undefined;

  function resolveAdapter() {
    const sdkKey = process.env.FLAGS;
    if (!sdkKey) return failClosedAdapter<ValueType, EntitiesType>();
    adapter ??= createVercelAdapter(sdkKey)<ValueType, EntitiesType>();
    return adapter;
  }

  return {
    // `flag()` resolves adapter metadata during module initialization, before
    // Next has loaded `.env.local`. Keep the SDK key lazy so local evaluation
    // uses its server-only value at request time.
    origin: () => ({
      provider: "vercel",
      get sdkKey() {
        return process.env.FLAGS;
      },
    }),
    async decide(input) {
      return resolveAdapter().decide(input);
    },
  };
}

export const builderConnectionsFlag = flag<boolean>({
  key: "builder-connections",
  adapter: managedVercelAdapter,
  defaultValue: false,
  description: "Show Connections in the authenticated App Builder.",
  options: booleanOptions,
});

export const builderResourceProvisioningFlag = flag<boolean>({
  key: "builder-resource-provisioning",
  adapter: managedVercelAdapter,
  defaultValue: false,
  description:
    "Provision selected GitHub repositories and Vercel projects before handoff.",
  options: booleanOptions,
});

export const builderComingSoonFlag = flag<boolean>({
  key: "builder-coming-soon",
  adapter: managedVercelAdapter,
  defaultValue: false,
  description: "Show Coming soon builder options and connections.",
  options: booleanOptions,
});

export const selfServiceSignupFlag = flag<boolean>({
  key: "self-service-signup",
  adapter: managedVercelAdapter,
  defaultValue: false,
  description: "Allow verified users to create a personal workspace.",
  options: booleanOptions,
});

export const passkeysFlag = flag<boolean>({
  key: "passkeys",
  adapter: managedVercelAdapter,
  defaultValue: false,
  description: "Show passkey authentication and account-management controls.",
  options: booleanOptions,
});
