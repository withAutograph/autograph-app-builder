import {
  parseProviderConnectionFailureReason,
  providerConnectionFailureMessage,
} from "@/lib/integrations/provider-connection-status";
import { safeProviderConnectionReturn } from "@/lib/integrations/provider-connection-return";
import { ProviderConnection, ProviderConnectionNotice } from "@/app/ui/provider-connection";
import { ProviderConnectionLoadingShell } from "@/app/ui/route-loading-shell";
import { Suspense } from "react";
import { SiVercel } from "react-icons/si";

type Props = {
  searchParams: Promise<{
    status?: string | string[];
    reason?: string | string[];
    returnTo?: string | string[];
    resume?: string | string[];
  }>;
};

async function VercelInstallationsContent({ searchParams }: Props) {
  const { status, reason, returnTo, resume } = await searchParams;
  const failureReason = parseProviderConnectionFailureReason(reason);
  const returnState = safeProviderConnectionReturn({
    returnTo,
    resumeKey: resume,
  });
  return (
    <ProviderConnection
      action="/vercel/installations/start"
      buttonLabel="Connect to Vercel"
      description="Choose the Vercel account Autograph may use for projects and deployments. Connecting it does not create or deploy anything yet."
      icon={<SiVercel size={22} />}
      returnTo={returnState.returnTo}
      resumeKey={returnState.resumeKey}
      title="Connect a Vercel team"
    >
      {status === "failed" ? (
        <ProviderConnectionNotice status="error">
          {providerConnectionFailureMessage("Vercel", failureReason)}
        </ProviderConnectionNotice>
      ) : null}
    </ProviderConnection>
  );
}

export default function VercelInstallationsPage(props: Props) {
  return (
    <Suspense
      fallback={
        <ProviderConnectionLoadingShell
          title="Connect a Vercel team"
          description="Choose the Vercel account Autograph may use for projects and deployments."
        />
      }
    >
      <VercelInstallationsContent {...props} />
    </Suspense>
  );
}
