import { ArrowRight, Check, LockKeyhole } from "lucide-react";
import { notFound } from "next/navigation";
import { FaGithub } from "react-icons/fa";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  localOAuthProviderDetails,
  parseLocalOAuthAuthorization,
} from "@/lib/auth/local-oauth-approval";
import {
  readProviderEmulation,
  type ProviderEmulation,
} from "@/lib/integrations/local-provider-emulation";

type Props = {
  params: Promise<{ provider: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function VercelMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 fill-current">
      <path d="M12 3 23 21H1L12 3Z" />
    </svg>
  );
}

function scalarValues(values: Record<string, string | string[] | undefined>) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === "string" ? value : undefined,
    ]),
  );
}

/** App-owned approval UI for Emulate's local authorization-code flow. */
export default async function LocalOAuthApprovalPage({
  params,
  searchParams,
}: Props) {
  let parsed;
  let emulation: ProviderEmulation;
  try {
    const [{ provider }, query] = await Promise.all([params, searchParams]);
    const configured = readProviderEmulation(process.env);
    if (!configured) notFound();
    emulation = configured;
    const appOrigin = emulation.canonicalOrigin;
    parsed = parseLocalOAuthAuthorization({
      provider,
      values: scalarValues(query),
      appOrigin,
      emulation,
      githubClientId: emulation.githubClientId,
      vercelClientId: emulation.vercelClientId,
    });
  } catch {
    notFound();
  }

  const details = localOAuthProviderDetails(parsed.provider);
  const ProviderMark = parsed.provider === "github" ? FaGithub : VercelMark;
  const approvalParams = new URLSearchParams();
  for (const [name, value] of Object.entries(parsed.authorization)) {
    if (value) approvalParams.set(name, value);
  }

  return (
    <main className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="flex h-16 items-center border-b px-5 sm:px-8">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2.5 text-sm font-medium">
          <VercelMark />
          <span>Autograph</span>
          <span className="text-muted-foreground">/</span>
          <span>App Builder</span>
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center px-5 py-12">
        <Card className="w-full max-w-md shadow-[0_18px_48px_rgba(0,0,0,0.08)]">
          <CardHeader className="items-center gap-4 px-6 pt-4 text-center sm:px-8">
            <div className="flex items-center gap-3" aria-hidden="true">
              <div className="grid size-11 place-items-center rounded-xl border bg-background shadow-sm">
                <VercelMark />
              </div>
              <ArrowRight className="size-4 text-muted-foreground" />
              <div className="grid size-11 place-items-center rounded-xl border bg-background shadow-sm">
                <ProviderMark className="size-5" />
              </div>
            </div>
            <div className="space-y-1.5">
              <CardTitle className="text-xl">
                Continue with {details.name}
              </CardTitle>
              <CardDescription className="leading-6">
                Authorize Autograph App Builder to use your local emulated{" "}
                {details.name} identity.
              </CardDescription>
            </div>
          </CardHeader>

          <CardContent className="space-y-5 px-6 sm:px-8">
            <div className="rounded-lg border bg-muted/30 p-3.5">
              <div className="flex items-center gap-3">
                <div className="grid size-9 place-items-center rounded-full bg-foreground text-background">
                  <ProviderMark className="size-4" />
                </div>
                <div className="min-w-0">
                  <p className="font-medium">{details.account}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {details.handle}
                  </p>
                </div>
                <Check className="ml-auto size-4" />
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Autograph will be able to
              </p>
              <div className="flex gap-3 text-sm leading-5">
                <LockKeyhole className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span>{details.scope}</span>
              </div>
            </div>

            {emulation.mode === "preview" ? (
              <a
                className={buttonVariants({ className: "h-10 w-full" })}
                href={`/local-oauth/${parsed.provider}/approve?${approvalParams}`}
              >
                Continue with {details.name}
              </a>
            ) : (
              <form
                method="post"
                action={`/local-oauth/${parsed.provider}/approve`}
              >
                {Object.entries(parsed.authorization).map(([name, value]) =>
                  value ? (
                    <input key={name} type="hidden" name={name} value={value} />
                  ) : null,
                )}
                <Button className="h-10 w-full" type="submit">
                  Continue with {details.name}
                </Button>
              </form>
            )}
          </CardContent>

          <CardFooter className="justify-center px-6 py-3 text-xs text-muted-foreground">
            {emulation.mode === "preview"
              ? "Preview only"
              : "Local development only"}{" "}
            · Powered by Emulate
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}
