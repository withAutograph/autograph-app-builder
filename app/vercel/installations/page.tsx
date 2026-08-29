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

export default async function VercelInstallationsPage({ searchParams }: Props) {
  const { status, reason } = await searchParams;
  const failureReason = parseProviderConnectionFailureReason(reason);
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyebrow">Autograph App Builder</p>
        <h1>Connect a Vercel team</h1>
        <p>
          Choose the Vercel account Autograph may use for projects and
          deployments. Connecting it does not create or deploy anything yet.
        </p>
        {status === "failed" ? (
          <p role="alert">
            {providerConnectionFailureMessage("Vercel", failureReason)}
          </p>
        ) : null}
        <form method="post" action="/vercel/installations/start">
          <button type="submit">Connect to Vercel</button>
        </form>
      </section>
    </main>
  );
}
