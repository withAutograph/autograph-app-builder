import { ProviderConnectionLoadingShell } from "../../../ui/route-loading-shell";

export default function Loading() {
  return (
    <ProviderConnectionLoadingShell
      title="Connect a GitHub App installation"
      description="Choose the repositories this workspace may inspect or update."
    />
  );
}
