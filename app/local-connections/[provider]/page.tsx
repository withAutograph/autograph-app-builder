import { notFound } from "next/navigation";
import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";

type Props = {
  params: Promise<{ provider: string }>;
  searchParams: Promise<{ state?: string; phase?: string }>;
};

/** Development-only consent surface; real provider installation pages remain external. */
export default async function LocalConnectionBridge({
  params,
  searchParams,
}: Props) {
  const [{ provider }, query] = await Promise.all([params, searchParams]);
  let emulation;
  try {
    emulation = readProviderEmulation(process.env);
  } catch {
    notFound();
  }
  if (!emulation || !["vercel", "github"].includes(provider) || !query.state)
    notFound();
  const authorizing = provider === "github" && query.phase === "authorize";
  const title =
    provider === "vercel" ? "Vercel team" : "GitHub App installation";
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyebrow">
          {emulation.mode === "preview"
            ? "Preview deployment"
            : "Local development"}
        </p>
        <h1>Connect {title}</h1>
        <p>
          This approval uses only the seeded Emulate account. It never contacts{" "}
          {provider === "vercel" ? "Vercel" : "GitHub"}.
        </p>
        <form method="post" action={`/local-connections/${provider}/complete`}>
          <input type="hidden" name="state" value={query.state} />
          {authorizing ? (
            <input type="hidden" name="phase" value="authorize" />
          ) : null}
          <button type="submit">Connect emulated {title}</button>
        </form>
      </section>
    </main>
  );
}
