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

export default async function VercelInstallationsPage({ searchParams }: Props) {
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
          <input name="returnTo" type="hidden" value={returnState.returnTo} />
          {returnState.resumeKey ? (
            <input
              name="resumeKey"
              type="hidden"
              value={returnState.resumeKey}
            />
          ) : null}
          <button type="submit">Connect to Vercel</button>
        </form>
      </section>
    </main>
  );
}
