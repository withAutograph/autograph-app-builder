import { createAuthPlugin } from "@better-auth-ui/core";
import {
  oauthProviderPlugin as coreOAuthProviderPlugin,
  type OAuthProviderPluginOptions,
} from "@better-auth-ui/core/plugins/oauth-provider";
export const oauthProviderPlugin = createAuthPlugin(
  coreOAuthProviderPlugin.id,
  (options: OAuthProviderPluginOptions = {}) => {
    const core = coreOAuthProviderPlugin(options);

    return core;
  },
);
