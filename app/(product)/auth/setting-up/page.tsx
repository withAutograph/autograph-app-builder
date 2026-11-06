"use client";

import { redirect } from "next/navigation";
import { useSyncExternalStore } from "react";

import { authClient } from "@/lib/auth-client";
import { resolveAuthCallbackURL } from "@/lib/auth/preview-auth-ui";
import { WorkspaceSetupStatus } from "@/app/ui/workspace-setup-status";

const subscribeToLocation = () => () => {
  // The setup page does not subscribe to location changes.
};
const getLocationSearch = () => window.location.search;
const getServerLocationSearch = () => "";

export default function SettingUpPage() {
  const session = authClient.useSession();
  const callbackSearch = useSyncExternalStore(
    subscribeToLocation,
    getLocationSearch,
    getServerLocationSearch,
  );

  if (session.data?.user) {
    redirect(resolveAuthCallbackURL("/", callbackSearch));
  }

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
