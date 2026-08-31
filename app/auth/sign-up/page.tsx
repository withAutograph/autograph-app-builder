import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { SignUp } from "@/components/auth/sign-up";
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

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<AuthPageSearchParams>;
}) {
  const [query, requestHeaders] = await Promise.all([searchParams, headers()]);
  const session = await getPreviewOAuthDeploymentSession({
    environment: process.env,
    headers: requestHeaders,
  });

  if (session?.user) {
    const origin = getPreviewOAuthDeploymentOrigin(process.env);
    const search = serializeAuthPageSearchParams(query);
    redirect(
      resolvePasskeyRedirectTo(DEFAULT_AUTH_REDIRECT_TO, search, origin),
    );
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <SignUp socialPosition="top" />
    </main>
  );
}
