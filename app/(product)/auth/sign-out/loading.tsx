import { AuthLoadingShell } from "@/app/ui/route-loading-shell";

export default function Loading() {
  return (
    <AuthLoadingShell
      title="Signing out of Autograph"
      description="Preparing secure sign-out…"
      label="Sign-out loading"
    />
  );
}
