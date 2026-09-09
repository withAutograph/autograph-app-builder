import { SignIn } from "@/components/auth/sign-in";
import { AuthContinuity } from "@/components/auth/auth-continuity";
import { getPreviewOAuthDeploymentOrigin } from "@/lib/auth/preview-oauth-deployment";
import {
  DEFAULT_AUTH_REDIRECT_TO,
  resolvePasskeyRedirectTo,
  serializeAuthPageSearchParams,
  type AuthPageSearchParams,
} from "@/lib/auth/preview-auth-ui";

async function SignInContent({
  searchParams,
}: {
  searchParams: Promise<AuthPageSearchParams>;
}) {
  const query = await searchParams;
  const signUpRedirectTo = resolvePasskeyRedirectTo(
    DEFAULT_AUTH_REDIRECT_TO,
    serializeAuthPageSearchParams(query),
    getPreviewOAuthDeploymentOrigin(process.env),
  );

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <AuthContinuity>
        <SignIn socialPosition="top" signUpRedirectTo={signUpRedirectTo} />
      </AuthContinuity>
    </main>
  );
}

export default function PreviewSignInPage(props: {
  searchParams: Promise<AuthPageSearchParams>;
}) {
  return (
    <Suspense fallback={<main className="min-h-svh" aria-busy="true" />}>
      <SignInContent {...props} />
    </Suspense>
  );
}
import { Suspense } from "react";
