import { notFound } from "next/navigation";
import { Suspense } from "react";

import { EmulationApproval, emulationApprovalStyles } from "@/app/ui/emulation-approval";
import type { EmulatedProvider } from "@/app/ui/emulation-approval";
import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";
import { parseProviderResumeKey } from "@/lib/integrations/provider-connection-return";
import {
  EMULATED_VERCEL_CONFIGURATION_ID,
  EMULATED_VERCEL_TEAM_ID,
} from "@/lib/integrations/provider-emulation-seed";

const singleQueryValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? undefined : value;

const hasConnectionState = (state: string | undefined) =>
  state !== undefined && state !== null && state.length > 0;

const connectionDetails = (provider: string, githubRepository: string) =>
  provider === "github"
    ? [
        { label: "Organization", value: "Autograph Local" },
        { label: "Repository", value: githubRepository },
      ]
    : [
        { label: "Team", value: "Autograph Local" },
        {
          label: "Team slug",
          value: process.env.EMULATE_VERCEL_TEAM_ID ?? EMULATED_VERCEL_TEAM_ID,
        },
        {
          label: "Configuration",
          value: process.env.EMULATE_VERCEL_CONFIGURATION_ID ?? EMULATED_VERCEL_CONFIGURATION_ID,
        },
      ];

interface Props {
  params: Promise<{ provider: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Development-only consent surface; real provider installation pages remain external. */
const LocalConnectionBridgeContent = async ({ params, searchParams }: Props) => {
  const [{ provider }, query] = await Promise.all([params, searchParams]);
  const parsedProvider = provider === "vercel" || provider === "github" ? provider : undefined;
  const state = singleQueryValue(query.state);
  let emulation;
  try {
    emulation = readProviderEmulation(process.env);
  } catch {
    notFound();
  }
  if (emulation === null || parsedProvider === undefined || !hasConnectionState(state)) {
    notFound();
  }
  const typedProvider: EmulatedProvider = parsedProvider;
  const resumeKey = parseProviderResumeKey(query.resume);
  const authorizing = provider === "github" && query.phase === "authorize";
  const providerName = provider === "vercel" ? "Vercel" : "GitHub";
  const title = authorizing ? "Authorize GitHub connection" : `Connect to ${providerName}`;
  const actionLabel = authorizing
    ? "Authorize emulated GitHub"
    : `Connect emulated ${providerName}`;
  const environment =
    emulation.mode === "preview" ? ("Preview deployment" as const) : ("Local development" as const);
  const details = connectionDetails(provider, emulation.githubRepository);
  const forwarded = authorizing
    ? ["client_id", "redirect_uri", "code_challenge", "code_challenge_method"]
    : [];
  return (
    <EmulationApproval
      provider={typedProvider}
      environment={environment}
      title={title}
      description={`Approve the prepared test account for this App Builder workspace.`}
      account="Autograph Developer"
      handle={provider === "github" ? "@autograph-dev" : "autograph-dev"}
      details={details}
      scope={
        provider === "github"
          ? "Access is limited to the GitHub App installation and repository shown above."
          : "Access is limited to the Vercel team and integration configuration shown above."
      }
      actionLabel={actionLabel}
      backHref={
        resumeKey !== null && resumeKey !== undefined && resumeKey.length > 0
          ? `/?resume=${encodeURIComponent(resumeKey)}`
          : "/"
      }
      action={
        <form method="post" action={`/local-connections/${provider}/complete`}>
          <input type="hidden" name="state" value={state} />
          {authorizing ? <input type="hidden" name="phase" value="authorize" /> : null}
          {forwarded.map((name) => {
            const value = singleQueryValue(query[name]);
            if (value === undefined || value === null || value.length === 0) {
              return null;
            }
            return <input key={name} type="hidden" name={name} value={value} />;
          })}
          <button className={emulationApprovalStyles.button} type="submit">
            {actionLabel}
          </button>
        </form>
      }
    />
  );
};

export default function LocalConnectionBridge(props: Props) {
  return (
    <Suspense fallback={<main className="min-h-svh" aria-busy="true" />}>
      <LocalConnectionBridgeContent {...props} />
    </Suspense>
  );
}
