import { AuthLoadingShell } from "@/app/ui/route-loading-shell";

export default function Loading() {
  return (
    <AuthLoadingShell
      title="Account settings"
      description="Loading your profile and security settings…"
      label="Account settings loading"
    />
  );
}
