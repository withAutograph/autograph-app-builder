import { ProviderConnectionLoadingShell } from "../../../ui/route-loading-shell";

export default function Loading() {
  return (
    <ProviderConnectionLoadingShell
      title="Connect a Vercel team"
      description="Choose the Vercel account Autograph may use for projects and deployments."
    />
  );
}
