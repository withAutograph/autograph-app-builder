import {
  parseProviderConnectionFailureReason,
  providerConnectionFailureMessage,
} from "@/lib/integrations/provider-connection-status";
import { safeProviderConnectionReturn } from "@/lib/integrations/provider-connection-return";
import { ProviderConnection, ProviderConnectionNotice } from "@/app/ui/provider-connection";
import { ProviderConnectionLoadingShell } from "@/app/ui/route-loading-shell";
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
  const { status, reason, returnTo, resume } = await searchParams;
  const failureReason = parseProviderConnectionFailureReason(reason);
  const returnState = safeProviderConnectionReturn({
    resumeKey: resume,
    returnTo,
  });
  return (
    <ProviderConnection
      action="/github/installations/start"
      buttonLabel="Install or update GitHub access"
      description="Choose repository access for a new installation, or connect an existing installation that already has access."
      icon={<FaGithub size={23} />}
      secondaryAction={{ buttonLabel: "Connect existing installation", mode: "existing" }}
      returnTo={returnState.returnTo}
      resumeKey={returnState.resumeKey}
      title="Connect a GitHub App installation"
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
          title="Connect a GitHub App installation"
          description="Choose the repositories this workspace may inspect or update."
        />
      }
    >
      <GitHubInstallationsContent {...props} />
    </Suspense>
  );
}
