/**
 * Server-owned, short-lived source configuration for a sandbox that has not
 * yet been created. It is populated only after the signed-in user's GitHub
 * installation has issued a read credential. The value is intentionally not
 * an environment variable: it never crosses into model-visible process state.
 */
export type VercelGitSessionSource = Readonly<{
  url: string;
  token: string;
  revision?: string;
}>;

type PendingGitSource =
  | { readonly kind: "ready"; readonly source: VercelGitSessionSource }
  | { readonly kind: "resolve"; readonly resolve: () => Promise<VercelGitSessionSource> };

const pendingSources = new Map<string, PendingGitSource>();

export const configureVercelSessionGitSource = (input: {
  sessionId: string;
  source: VercelGitSessionSource;
}) => {
  pendingSources.set(input.sessionId, { kind: "ready", source: input.source });
};

/** Registers source intent without contacting GitHub on a healthy resume. */
export const configureVercelSessionGitSourceResolver = (input: {
  sessionId: string;
  resolve: () => Promise<VercelGitSessionSource>;
}) => {
  pendingSources.set(input.sessionId, { kind: "resolve", resolve: input.resolve });
};

const matchingSource = (sessionId: string): PendingGitSource | undefined => {
  const exact = pendingSources.get(sessionId);
  if (exact !== undefined) {
    return exact;
  }

  // Eve may decorate the public run id when deriving its provider session
  // key. Resolve only an unambiguous delimiter-bounded suffix; never fall
  // back to an arbitrary pending source.
  const matches = [...pendingSources.entries()].filter(
    ([candidate]) =>
      candidate !== sessionId &&
      (sessionId.includes(`-${candidate}-`) || sessionId.endsWith(`-${candidate}`)),
  );
  return matches.length === 1 ? matches[0]?.[1] : undefined;
};

export const hasVercelSessionGitSource = (sessionId: string): boolean =>
  matchingSource(sessionId) !== undefined;

export const resolveVercelSessionGitSource = async (
  sessionId: string,
): Promise<VercelGitSessionSource | undefined> => {
  const pending = matchingSource(sessionId);
  if (pending?.kind === "ready") {
    return pending.source;
  }
  return pending ? await pending.resolve() : undefined;
};

/** Test and diagnostic readback; intentionally does not invoke a lazy resolver. */
export const readVercelSessionGitSource = (sessionId: string) => {
  const pending = matchingSource(sessionId);
  return pending?.kind === "ready" ? pending.source : undefined;
};

export const clearVercelSessionGitSource = (sessionId: string) => {
  pendingSources.delete(sessionId);
};
