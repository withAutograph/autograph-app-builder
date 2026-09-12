import { cacheLife } from "next/cache";
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
} from "@/lib/auth/preview-auth-ui";
import type { AuthPageSearchParams } from "@/lib/auth/preview-auth-ui";

async function hasAuthenticatedVisitor() {
  "use cache: private";
  cacheLife("minutes");

  const requestHeaders = await headers();
  const session = await getPreviewOAuthDeploymentSession({
    environment: process.env,
    headers: requestHeaders,
  });

  return Boolean(session?.user);
}

async function RedirectAuthenticatedVisitor({
  searchParams,
}: {
  searchParams: Promise<AuthPageSearchParams>;
}) {
  if (!(await hasAuthenticatedVisitor())) {
    return null;
  }

  const query = await searchParams;
  const origin = getPreviewOAuthDeploymentOrigin(process.env);
  const search = serializeAuthPageSearchParams(query);
  const signInRedirectTo = resolvePasskeyRedirectTo(DEFAULT_AUTH_REDIRECT_TO, search, origin);

  redirect(signInRedirectTo);
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

export default function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<AuthPageSearchParams>;
}) {
  return (
    <>
      <SignUpSurface />
      <Suspense fallback={null}>
        <RedirectAuthenticatedVisitor searchParams={searchParams} />
      </Suspense>
    </>
  );
}
