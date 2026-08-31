import { SignUp } from "@/components/auth/sign-up";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ passkey?: string | string[] }>;
}) {
  const passkeyUnavailable = (await searchParams).passkey === "unavailable";

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <SignUp passkeyUnavailable={passkeyUnavailable} socialPosition="top" />
    </main>
  );
}
