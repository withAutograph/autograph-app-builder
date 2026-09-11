/**
 * Server-owned, short-lived source configuration for a sandbox that has not
 * yet been created. It is populated only after the signed-in user's GitHub
 * installation has issued a read credential. The value is intentionally not
 * an environment variable: it never crosses into model-visible process state.
 */
export type VercelGitSessionSource = Readonly<{
  url: string;
  token: string;
}>;

const pendingSources = new Map<string, VercelGitSessionSource>();

export function configureVercelSessionGitSource(input: {
  sessionId: string;
  source: VercelGitSessionSource;
}) {
  pendingSources.set(input.sessionId, input.source);
}

export function readVercelSessionGitSource(sessionId: string) {
  const exact = pendingSources.get(sessionId);
  if (exact !== undefined) return exact;

  // Eve may decorate the public run id when deriving its provider session
  // key. Resolve only an unambiguous delimiter-bounded suffix; never fall
  // back to an arbitrary pending source.
  const matches = [...pendingSources.entries()].filter(
    ([candidate]) =>
      candidate !== sessionId &&
      (sessionId.includes(`-${candidate}-`) ||
        sessionId.endsWith(`-${candidate}`)),
  );
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

export function clearVercelSessionGitSource(sessionId: string) {
  pendingSources.delete(sessionId);
}
