import { OAuthConsent } from "@/components/auth/oauth-provider/oauth-consent";

export default function PreviewConsentPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <OAuthConsent />
    </main>
  );
}
