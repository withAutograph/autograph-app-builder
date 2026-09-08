import {
  parseProviderConnectionFailureReason,
  providerConnectionFailureMessage,
} from "@/lib/integrations/provider-connection-status";
import { safeProviderConnectionReturn } from "@/lib/integrations/provider-connection-return";
import {
  ProviderConnection,
  ProviderConnectionNotice,
} from "@/app/ui/provider-connection";
import { FaGithub } from "react-icons/fa";

type Props = {
  searchParams: Promise<{
    status?: string | string[];
    reason?: string | string[];
    returnTo?: string | string[];
    resume?: string | string[];
  }>;
};

export default async function GitHubInstallationsPage({ searchParams }: Props) {
  const { status, reason, returnTo, resume } = await searchParams;
  const failureReason = parseProviderConnectionFailureReason(reason);
  const returnState = safeProviderConnectionReturn({
    returnTo,
    resumeKey: resume,
  });
  return (
    <ProviderConnection
      action="/github/installations/start"
      buttonLabel="Install or update GitHub access"
      description="Choose the repositories this workspace may inspect or update, or allow all repositories. For an existing installation, GitHub must have Redirect on update enabled to return here."
      icon={<FaGithub size={23} />}
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
