"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { authClient } from "@/lib/auth-client";
import { resolveAuthCallbackURL } from "@/lib/auth/preview-auth-ui";

export default function SettingUpPage() {
  const router = useRouter();
  const session = authClient.useSession();

  useEffect(() => {
    if (session.data?.user) {
      router.replace(resolveAuthCallbackURL("/", window.location.search));
    }
  }, [router, session.data?.user]);

  if (session.error) {
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <section className="flex w-full max-w-sm flex-col gap-4 text-center">
          <h1 className="text-xl font-semibold">Workspace setup failed</h1>
          <p className="text-sm text-muted-foreground">
            We couldn’t finish setting up your workspace. Please sign in again.
          </p>
          <a
            className="text-sm font-medium underline underline-offset-4"
            href={`/auth/sign-in?callbackURL=${encodeURIComponent(
              resolveAuthCallbackURL("/", window.location.search),
            )}`}
          >
            Return to sign in
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <section
        className="flex w-full max-w-sm flex-col items-center gap-4 text-center"
        aria-live="polite"
      >
        <div
          className="size-8 animate-spin rounded-full border-2 border-muted border-t-foreground"
          aria-hidden="true"
        />
        <h1 className="text-xl font-semibold">Setting up your workspace…</h1>
        <p className="text-sm text-muted-foreground">
          This will only take a moment.
        </p>
      </section>
    </main>
  );
}
