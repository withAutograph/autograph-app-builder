import { vercelAdapter } from "@flags-sdk/vercel";
import { flag } from "flags/next";

const booleanOptions = [
  { value: false, label: "Disabled" },
  { value: true, label: "Enabled" },
];

export const builderConnectionsFlag = flag<boolean>({
  key: "builder-connections",
  adapter: vercelAdapter,
  defaultValue: false,
  description: "Show Connections in the authenticated App Builder.",
  options: booleanOptions,
});

export const selfServiceSignupFlag = flag<boolean>({
  key: "self-service-signup",
  adapter: vercelAdapter,
  defaultValue: false,
  description: "Allow verified users to create a personal workspace.",
  options: booleanOptions,
});
