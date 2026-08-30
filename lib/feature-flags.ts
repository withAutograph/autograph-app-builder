import { vercelAdapter } from "@flags-sdk/vercel";
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
  // The Vercel adapter validates FLAGS at construction time. Keep local
  // startup, test runs, and unavailable managers fail-closed instead.
  if (!process.env.FLAGS) return failClosedAdapter<ValueType, EntitiesType>();
  return vercelAdapter<ValueType, EntitiesType>();
}

export const builderConnectionsFlag = flag<boolean>({
  key: "builder-connections",
  adapter: managedVercelAdapter,
  defaultValue: false,
  description: "Show Connections in the authenticated App Builder.",
  options: booleanOptions,
});

export const selfServiceSignupFlag = flag<boolean>({
  key: "self-service-signup",
  adapter: managedVercelAdapter,
  defaultValue: false,
  description: "Allow verified users to create a personal workspace.",
  options: booleanOptions,
});
