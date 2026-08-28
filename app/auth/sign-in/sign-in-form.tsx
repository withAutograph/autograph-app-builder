"use client";

import { useState, type FormEvent } from "react";

import {
  currentOAuthQuery,
  postPreviewOAuthInteraction,
} from "@/lib/auth/preview-oauth-browser";

export function SignInForm() {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const oauthQuery = currentOAuthQuery(window.location.search);
    try {
      const signInRedirect = await postPreviewOAuthInteraction({
        endpoint: "/api/auth/sign-in/social",
        body: {
          provider: "github",
          oauth_query: oauthQuery,
        },
      });
      if (signInRedirect === undefined) {
        throw new Error("The authorization flow did not return a destination.");
      }
      window.location.assign(signInRedirect);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="auth-card">
      <p className="eyebrow">Autograph App Builder</p>
      <h1>Sign in to Preview</h1>
      <p>
        Use an invited GitHub account with one active App Builder workspace.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Connecting…" : "Continue with GitHub"}
      </button>
    </form>
  );
}
