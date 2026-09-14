import { Suspense } from "react";

import { SignIn } from "@/components/auth/sign-in";
import { AuthContinuity } from "@/components/auth/auth-continuity";
import { getPreviewOAuthDeploymentOrigin } from "@/lib/auth/preview-oauth-deployment";
import {
  DEFAULT_AUTH_REDIRECT_TO,
  resolvePasskeyRedirectTo,
  serializeAuthPageSearchParams,
} from "@/lib/auth/preview-auth-ui";
import type { AuthPageSearchParams } from "@/lib/auth/preview-auth-ui";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function SignInSurface({ searchParams }: { searchParams: Promise<AuthPageSearchParams> }) {
  const search = serializeAuthPageSearchParams(await searchParams);
  const origin = getPreviewOAuthDeploymentOrigin(process.env);
  const signUpRedirectTo = resolvePasskeyRedirectTo(DEFAULT_AUTH_REDIRECT_TO, search, origin);
  return <SignIn socialPosition="top" signUpRedirectTo={signUpRedirectTo} />;
}

export default function PreviewSignInPage({
  searchParams,
}: {
  searchParams: Promise<AuthPageSearchParams>;
}) {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <AuthContinuity>
        <Suspense fallback={<p role="status">Loading sign in…</p>}>
          <SignInSurface searchParams={searchParams} />
        </Suspense>
      </AuthContinuity>
    </main>
  );
}
