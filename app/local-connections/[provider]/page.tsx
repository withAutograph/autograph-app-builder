import { ArrowRight, LockKeyhole } from "lucide-react";
import { notFound } from "next/navigation";
import { FaGithub } from "react-icons/fa";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";
import {
  EMULATED_GITHUB_INSTALLATION_ID,
  EMULATED_GITHUB_REPOSITORY,
  EMULATED_VERCEL_CONFIGURATION_ID,
  EMULATED_VERCEL_TEAM_ID,
} from "@/lib/integrations/provider-emulation-seed";

type Props = {
  params: Promise<{ provider: string }>;
  searchParams: Promise<{ state?: string; phase?: string }>;
};

function VercelMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 fill-current">
      <path d="M12 3 23 21H1L12 3Z" />
    </svg>
  );
}

/** Emulation-only consent surface; real provider installation pages remain external. */
export default async function LocalConnectionBridge({
  params,
  searchParams,
}: Props) {
  const [{ provider }, query] = await Promise.all([params, searchParams]);
  let emulation;
  try {
    emulation = readProviderEmulation(process.env);
  } catch {
    notFound();
  }
  if (!emulation || !["vercel", "github"].includes(provider) || !query.state)
    notFound();
  const authorizing = provider === "github" && query.phase === "authorize";
  const title =
    provider === "vercel" ? "Vercel team" : "GitHub App installation";
  const scope =
    provider === "vercel"
      ? [
          ["Team", EMULATED_VERCEL_TEAM_ID],
          ["Configuration", EMULATED_VERCEL_CONFIGURATION_ID],
        ]
      : [
          ["Organization", EMULATED_GITHUB_REPOSITORY.split("/")[0]],
          ["Repository", EMULATED_GITHUB_REPOSITORY],
          ["Installation", String(EMULATED_GITHUB_INSTALLATION_ID)],
        ];
  const ProviderMark = provider === "github" ? FaGithub : VercelMark;
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
              <CardTitle className="text-xl">Connect {title}</CardTitle>
              <CardDescription className="leading-6">
                Approve access to the seeded Emulate scope. This never contacts{" "}
                {provider === "vercel" ? "Vercel" : "GitHub"}.
              </CardDescription>
            </div>
          </CardHeader>

          <CardContent className="space-y-5 px-6 sm:px-8">
            <dl
              className="divide-y rounded-lg border bg-muted/30 px-3.5"
              aria-label={`${title} scope`}
            >
              {scope.map(([label, value]) => (
                <div
                  className="grid grid-cols-[7rem_1fr] gap-3 py-3 text-sm"
                  key={label}
                >
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="truncate font-medium">{value}</dd>
                </div>
              ))}
            </dl>

            <div className="flex gap-3 text-sm leading-5">
              <LockKeyhole className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>The connection is isolated to this development scope.</span>
            </div>

            <form
              method="post"
              action={`/local-connections/${provider}/complete`}
            >
              <input type="hidden" name="state" value={query.state} />
              {authorizing ? (
                <input type="hidden" name="phase" value="authorize" />
              ) : null}
              <Button className="h-10 w-full" type="submit">
                Connect emulated {title}
              </Button>
            </form>
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
