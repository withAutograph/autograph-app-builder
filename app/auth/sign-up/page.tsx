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

async function RedirectAuthenticatedVisitor({
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

  return null;
}

function SignUpSurface() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <AuthContinuity action="sign-up">
        <SignUp socialPosition="top" />
      </AuthContinuity>
    </main>
  );
}

async function SignUpContent({
  searchParams,
}: {
  searchParams: Promise<AuthPageSearchParams>;
}) {
  await RedirectAuthenticatedVisitor({ searchParams });
  return <SignUpSurface />;
}

export default function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<AuthPageSearchParams>;
}) {
  return (
    <Suspense fallback={<SignUpSurface />}>
      <SignUpContent searchParams={searchParams} />
    </Suspense>
  );
}
