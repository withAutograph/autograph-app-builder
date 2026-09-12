import { AuthLoadingShell } from "@/app/ui/route-loading-shell";

export default function Loading() {
  return (
    <AuthLoadingShell
      title="Authorize access"
      description="Loading the requested permissions…"
      label="Authorization request loading"
    />
  );
}
