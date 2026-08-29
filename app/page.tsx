import { headers } from "next/headers";

import { getPreviewOAuthDeploymentAuth } from "@/lib/auth/preview-oauth-deployment";
import { loadBuilderIntegrationState } from "@/lib/integrations/builder-integration-deployment";
import {
  parseProviderConnectionFailureReason,
  type ProviderConnectionNotice,
} from "@/lib/integrations/provider-connection-status";

import { AppBuilder } from "./ui/app-builder";

type PageProps = {
  searchParams: Promise<{
    mode?: string | string[];
    vercel?: string | string[];
    github?: string | string[];
    reason?: string | string[];
    vercelReason?: string | string[];
    githubReason?: string | string[];
  }>;
};

async function currentUser() {
  try {
    const auth = getPreviewOAuthDeploymentAuth(process.env);
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) return undefined;
    return {
      id: session.user.id,
      name: session.user.name || "Autograph user",
      email: session.user.email,
    };
  } catch {
    return undefined;
  }
}

export default async function Home({ searchParams }: PageProps) {
  const [query, user] = await Promise.all([searchParams, currentUser()]);
  const mode = typeof query.mode === "string" ? query.mode : undefined;
  const notices: ProviderConnectionNotice[] = [];
  for (const provider of ["vercel", "github"] as const) {
    const status = query[provider];
    if (status !== "connected" && status !== "failed") continue;
    notices.push({
      provider,
      status,
      ...(status === "failed"
        ? {
            reason: parseProviderConnectionFailureReason(
              query[provider === "vercel" ? "vercelReason" : "githubReason"] ??
                query.reason,
            ),
          }
        : {}),
    });
  }
  const authenticated =
    user !== undefined ||
    (process.env.NODE_ENV !== "production" && mode === "authenticated");
  const integrations = await loadBuilderIntegrationState({
    environment: process.env,
    userId: user?.id,
  });

  return (
    <AppBuilder
      authenticated={authenticated && mode !== "anonymous"}
      integrations={integrations}
      providerNotices={notices}
    />
  );
}
