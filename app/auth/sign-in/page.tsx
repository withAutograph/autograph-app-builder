import { SignIn } from "@/components/auth/sign-in";
import { AuthContinuity } from "@/components/auth/auth-continuity";

export default function PreviewSignInPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <AuthContinuity>
        <SignIn socialPosition="top" />
      </AuthContinuity>
    </main>
  );
}
