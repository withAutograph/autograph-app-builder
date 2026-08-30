"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { authClient } from "@/lib/auth-client";
import { resolveAuthCallbackURL } from "@/lib/auth/preview-auth-ui";
import { WorkspaceSetupStatus } from "@/app/ui/workspace-setup-status";

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
      <WorkspaceSetupStatus
        status="error"
        callbackUrl={resolveAuthCallbackURL("/", window.location.search)}
      />
    );
  }

  return (
    <WorkspaceSetupStatus
      status="loading"
      loadingTitle="Setting up your workspace…"
    />
  );
}
