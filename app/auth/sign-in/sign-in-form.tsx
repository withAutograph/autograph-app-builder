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
    const form = new FormData(event.currentTarget);
    const oauthQuery = currentOAuthQuery(window.location.search);
    try {
      const signInRedirect = await postPreviewOAuthInteraction({
        endpoint: "/api/auth/sign-in/email",
        body: {
          email: form.get("email"),
          password: form.get("password"),
          rememberMe: false,
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
      <p>Use an invited account with one active App Builder workspace.</p>
      <label>
        Email
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={12}
          required
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Continue"}
      </button>
    </form>
  );
}
