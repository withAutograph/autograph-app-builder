import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Account connected | Autograph",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function AccountConnectedPage() {
  return (
    <main className="flex min-h-svh items-center justify-center px-6 py-12">
      <section
        aria-labelledby="account-connected-heading"
        className="max-w-md space-y-3 text-center"
      >
        <h1 id="account-connected-heading" className="text-2xl font-semibold tracking-tight">
          Account connected
        </h1>
        <p className="text-muted-foreground">
          Your app preparation resumes automatically in the original conversation. No further action
          is needed here.
        </p>
      </section>
    </main>
  );
}
