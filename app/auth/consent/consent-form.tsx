"use client";

import { useEffect, useState } from "react";

import {
  currentOAuthQuery,
  loadPreviewConsentContext,
  postPreviewOAuthInteraction,
  type PreviewConsentContext,
} from "@/lib/auth/preview-oauth-browser";

export function ConsentForm() {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [context, setContext] = useState<PreviewConsentContext>();

  useEffect(() => {
    let active = true;
    void loadPreviewConsentContext({ search: window.location.search })
      .then((result) => {
        if (active) setContext(result);
      })
      .catch(() => {
        if (active)
          setError("The verified authorization request is unavailable.");
      });
    return () => {
      active = false;
    };
  }, []);

  async function decide(accept: boolean) {
    setPending(true);
    setError(undefined);
    try {
      const redirect = await postPreviewOAuthInteraction({
        endpoint: "/api/auth/oauth2/consent",
        body: {
          accept,
          oauth_query: currentOAuthQuery(window.location.search),
        },
      });
      if (redirect === undefined) {
        throw new Error("The authorization flow did not return a destination.");
      }
      window.location.assign(redirect);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Consent failed.");
      setPending(false);
    }
  }

  return (
    <section className="auth-card">
      <p className="eyebrow">Preview authorization</p>
      <h1>
        {context ? `Authorize ${context.clientName}?` : "Verify this client"}
      </h1>
      <p>
        This one confirmation binds access to your sole active assigned
        workspace. Access expires after five minutes.
      </p>
      {context ? (
        <>
          <p>
            Verified client: <code>{context.clientId}</code>
          </p>
          <p>Requested permissions:</p>
          <ul>
            {context.requestedScopes.map((scope) => (
              <li key={scope}>
                <code>{scope}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="auth-actions">
        <button
          type="button"
          disabled={pending || context === undefined}
          onClick={() => decide(false)}
        >
          Deny
        </button>
        <button
          type="button"
          disabled={pending || context === undefined}
          onClick={() => decide(true)}
        >
          {pending ? "Authorizing…" : "Allow Preview access"}
        </button>
      </div>
    </section>
  );
}
