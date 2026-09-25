import {
  parseProviderConnectionFailureReason,
  providerConnectionFailureMessage,
} from "@/lib/integrations/provider-connection-status";
import { safeProviderConnectionReturn } from "@/lib/integrations/provider-connection-return";
import { ProviderConnection, ProviderConnectionNotice } from "@/app/ui/provider-connection";
import { ProviderConnectionLoadingShell } from "@/app/ui/route-loading-shell";
import { verifiedGitHubConnectionTarget } from "@/lib/auth/github-app-installation-deployment";
import { headers } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import { FaGithub } from "react-icons/fa";

interface Props {
  searchParams: Promise<{
    status?: string | string[];
    reason?: string | string[];
    returnTo?: string | string[];
    resume?: string | string[];
  }>;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function GitHubInstallationsContent({ searchParams }: Props) {
  await connection();
  const { status, reason, returnTo, resume } = await searchParams;
  const failureReason = parseProviderConnectionFailureReason(reason);
  const returnState = safeProviderConnectionReturn({
    resumeKey: resume,
    returnTo,
  });
  let target;
  if (returnState.resumeKey !== undefined) {
    target = await verifiedGitHubConnectionTarget({
      environment: process.env,
      headers: await headers(),
      resumeKey: returnState.resumeKey,
    });
  }
  return (
    <ProviderConnection
      action="/github/installations/start"
      buttonLabel="Continue with GitHub"
      description={
        target
          ? `Connect GitHub so Autograph can access ${target.repository.fullName}. GitHub will ask you to approve access if needed.`
          : "Connect GitHub so Autograph can access the repository for this app. GitHub will ask you to approve access if needed."
      }
      headerLabel="Connect GitHub"
      icon={<FaGithub size={23} />}
      returnTo={returnState.returnTo}
      resumeKey={returnState.resumeKey}
      title="Connect GitHub"
    >
      {status === "connected" ? (
        <ProviderConnectionNotice status="success">
          The GitHub App installation is connected.
        </ProviderConnectionNotice>
      ) : null}
      {status === "failed" ? (
        <ProviderConnectionNotice status="error">
          {providerConnectionFailureMessage("GitHub", failureReason)}
        </ProviderConnectionNotice>
      ) : null}
    </ProviderConnection>
  );
}

export default function GitHubInstallationsPage(props: Props) {
  return (
    <Suspense
      fallback={
        <ProviderConnectionLoadingShell
          title="Connect GitHub"
          headerLabel="Connect GitHub"
          description="Prepare the GitHub connection for this app."
        />
      }
    >
      <GitHubInstallationsContent {...props} />
    </Suspense>
  );
}
