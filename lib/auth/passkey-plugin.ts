import { createAuthPlugin } from "@better-auth-ui/core";
import { passkeyPlugin as corePasskeyPlugin } from "@better-auth-ui/core/plugins/passkey";
import type { PasskeyPluginOptions } from "@better-auth-ui/core/plugins/passkey";

export const passkeyPlugin = createAuthPlugin(
  corePasskeyPlugin.id,
  (options: PasskeyPluginOptions = {}) => corePasskeyPlugin(options),
);
