import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { SignUp } from "@/components/auth/sign-up";
import { AuthContinuity } from "@/components/auth/auth-continuity";
import {
  getPreviewOAuthDeploymentOrigin,
  getPreviewOAuthDeploymentSession,
} from "@/lib/auth/preview-oauth-deployment";
import {
  DEFAULT_AUTH_REDIRECT_TO,
  resolvePasskeyRedirectTo,
  serializeAuthPageSearchParams,
  type AuthPageSearchParams,
} from "@/lib/auth/preview-auth-ui";

async function SignUpContent({
  searchParams,
}: {
  searchParams: Promise<AuthPageSearchParams>;
}) {
  const [query, requestHeaders] = await Promise.all([searchParams, headers()]);
  const origin = getPreviewOAuthDeploymentOrigin(process.env);
  const search = serializeAuthPageSearchParams(query);
  const signInRedirectTo = resolvePasskeyRedirectTo(
    DEFAULT_AUTH_REDIRECT_TO,
    search,
    origin,
  );
  const session = await getPreviewOAuthDeploymentSession({
    environment: process.env,
    headers: requestHeaders,
  });

  if (session?.user) {
    redirect(signInRedirectTo);
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <AuthContinuity action="sign-up">
        <SignUp socialPosition="top" signInRedirectTo={signInRedirectTo} />
      </AuthContinuity>
    </main>
  );
}

export default function SignUpPage(props: {
  searchParams: Promise<AuthPageSearchParams>;
}) {
  return (
    <Suspense fallback={<main className="min-h-svh" aria-busy="true" />}>
      <SignUpContent {...props} />
    </Suspense>
  );
}
