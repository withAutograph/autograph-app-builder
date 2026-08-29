import {
  parseProviderConnectionFailureReason,
  providerConnectionFailureMessage,
} from "@/lib/integrations/provider-connection-status";

type Props = {
  searchParams: Promise<{
    status?: string | string[];
    reason?: string | string[];
  }>;
};

export default async function GitHubInstallationsPage({ searchParams }: Props) {
  const { status, reason } = await searchParams;
  const failureReason = parseProviderConnectionFailureReason(reason);
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
          <button type="submit">Install or update GitHub access</button>
        </form>
      </section>
    </main>
  );
}
