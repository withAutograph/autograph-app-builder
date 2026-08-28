import { headers } from "next/headers";

import { getPreviewOAuthDeploymentAuth } from "@/lib/auth/preview-oauth-deployment";

import { AppBuilder } from "./ui/app-builder";

type PageProps = { searchParams: Promise<{ mode?: string }> };

async function currentUser() {
  try {
    const auth = getPreviewOAuthDeploymentAuth(process.env);
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) return undefined;
    return {
      name: session.user.name || "Autograph user",
      email: session.user.email,
    };
  } catch {
    return undefined;
  }
}

export default async function Home({ searchParams }: PageProps) {
  const [{ mode }, user] = await Promise.all([searchParams, currentUser()]);
  const authenticated =
    user !== undefined ||
    (process.env.NODE_ENV !== "production" && mode === "authenticated");

  return (
    <AppBuilder
      authenticated={authenticated && mode !== "anonymous"}
      user={user ?? { name: "Autograph User", email: "Signed in with GitHub" }}
    />
  );
}
