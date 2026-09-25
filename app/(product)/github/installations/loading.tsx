import { ProviderConnectionLoadingShell } from "../../../ui/route-loading-shell";

export default function Loading() {
  return (
    <ProviderConnectionLoadingShell
      title="Connect GitHub"
      headerLabel="Connect GitHub"
      description="Prepare the GitHub connection for this app."
    />
  );
}
