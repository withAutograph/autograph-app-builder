type Props = { searchParams: Promise<{ status?: string }> };

export default async function VercelInstallationsPage({ searchParams }: Props) {
  const { status } = await searchParams;
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
            Vercel could not be connected. Start a new authorization attempt.
          </p>
        ) : null}
        <form method="post" action="/vercel/installations/start">
          <button type="submit">Connect to Vercel</button>
        </form>
      </section>
    </main>
  );
}
