import { SignIn } from "@/components/auth/sign-in";
import { readPasskeyOnboardingConfig } from "@/lib/auth/passkey-onboarding";

export default function PreviewSignInPage() {
  let passkeyOnboarding = false;
  try {
    passkeyOnboarding = readPasskeyOnboardingConfig(process.env) !== null;
  } catch {
    passkeyOnboarding = false;
  }
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <SignIn socialPosition="top" passkeyOnboarding={passkeyOnboarding} />
    </main>
  );
}
