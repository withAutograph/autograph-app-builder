import {
  parseProviderConnectionFailureReason,
  providerConnectionFailureMessage,
} from "@/lib/integrations/provider-connection-status";
import { safeProviderConnectionReturn } from "@/lib/integrations/provider-connection-return";

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
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyebrow">Autograph App Builder</p>
        <h1>Connect a GitHub App installation</h1>
        <p>
          Choose only the repositories this workspace may inspect or update.
          GitHub will ask you to confirm the installation and return here.
        </p>
        {status === "connected" ? (
          <p role="status">The GitHub App installation is connected.</p>
        ) : null}
        {status === "failed" ? (
          <p role="alert">
            {providerConnectionFailureMessage("GitHub", failureReason)}
          </p>
        ) : null}
        <form method="post" action="/github/installations/start">
          <input name="returnTo" type="hidden" value={returnState.returnTo} />
          {returnState.resumeKey ? (
            <input
              name="resumeKey"
              type="hidden"
              value={returnState.resumeKey}
            />
          ) : null}
          <button type="submit">Install or update GitHub access</button>
        </form>
      </section>
    </main>
  );
}
