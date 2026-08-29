import { createAuthPlugin } from "@better-auth-ui/core";
import {
  oauthProviderPlugin as coreOAuthProviderPlugin,
  type OAuthProviderPluginOptions,
} from "@better-auth-ui/core/plugins/oauth-provider";
import { OAuthConsent } from "@/components/auth/oauth-provider/oauth-consent";

export const oauthProviderPlugin = createAuthPlugin(
  coreOAuthProviderPlugin.id,
  (options: OAuthProviderPluginOptions = {}) => {
    const core = coreOAuthProviderPlugin(options);

    return {
      ...core,
      views: {
        auth: {
          oauthConsent: OAuthConsent,
        },
      },
    };
  },
);
