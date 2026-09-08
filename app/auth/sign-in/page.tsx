import { SignIn } from "@/components/auth/sign-in";
import { AuthContinuity } from "@/components/auth/auth-continuity";
import { getPreviewOAuthDeploymentOrigin } from "@/lib/auth/preview-oauth-deployment";
import {
  DEFAULT_AUTH_REDIRECT_TO,
  resolvePasskeyRedirectTo,
  serializeAuthPageSearchParams,
  type AuthPageSearchParams,
} from "@/lib/auth/preview-auth-ui";

export default async function PreviewSignInPage({
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
