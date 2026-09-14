import { Suspense } from "react";
import { AuthLoadingShell } from "../../../ui/route-loading-shell";

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
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <AuthContinuity>
        <SignIn socialPosition="top" signUpRedirectTo={signUpRedirectTo} />
      </AuthContinuity>
    </main>
  );
}

export default function PreviewSignInPage({
  searchParams,
}: {
  searchParams: Promise<AuthPageSearchParams>;
}) {
  return (
    <Suspense fallback={<AuthLoadingShell title="Sign in to Autograph" />}>
      <SignInSurface searchParams={searchParams} />
    </Suspense>
  );
}
