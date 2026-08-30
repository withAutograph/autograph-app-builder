import { SignIn } from "@/components/auth/sign-in";

export default function PreviewSignInPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <SignIn socialPosition="top" />
    </main>
  );
}
