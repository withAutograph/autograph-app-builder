import { SignUp } from "@/components/auth/sign-up";

export default function SignUpPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <SignUp socialPosition="top" />
    </main>
  );
}
