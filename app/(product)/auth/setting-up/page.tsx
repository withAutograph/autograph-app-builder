"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

import { authClient } from "@/lib/auth-client";
import { resolveAuthCallbackURL } from "@/lib/auth/preview-auth-ui";
import { WorkspaceSetupStatus } from "@/app/ui/workspace-setup-status";

const subscribeToLocation = () => () => undefined;
const getLocationSearch = () => window.location.search;
const getServerLocationSearch = () => "";

export default function SettingUpPage() {
  const router = useRouter();
  const session = authClient.useSession();
  const callbackSearch = useSyncExternalStore(
    subscribeToLocation,
    getLocationSearch,
    getServerLocationSearch,
  );

  useEffect(() => {
    if (session.data?.user) {
      router.replace(resolveAuthCallbackURL("/", callbackSearch));
    }
  }, [callbackSearch, router, session.data?.user]);

  if (session.error || (!session.isPending && !session.data?.user)) {
    return (
      <WorkspaceSetupStatus
        status="error"
        callbackUrl={resolveAuthCallbackURL("/", callbackSearch)}
      />
    );
  }

  return <WorkspaceSetupStatus status="loading" loadingTitle="Setting up your workspace…" />;
}
