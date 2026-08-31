import { notFound } from "next/navigation";

import {
  EmulationApproval,
  emulationApprovalStyles,
  type EmulatedProvider,
} from "@/app/ui/emulation-approval";
import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";
import { parseProviderResumeKey } from "@/lib/integrations/provider-connection-return";
import {
  EMULATED_VERCEL_CONFIGURATION_ID,
  EMULATED_VERCEL_TEAM_ID,
} from "@/lib/integrations/provider-emulation-seed";

type Props = {
  params: Promise<{ provider: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Development-only consent surface; real provider installation pages remain external. */
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
  if (
    !emulation ||
    !["vercel", "github"].includes(provider) ||
    typeof query.state !== "string"
  )
    notFound();
  const typedProvider = provider as EmulatedProvider;
  const resumeKey = parseProviderResumeKey(query.resume);
  const authorizing = provider === "github" && query.phase === "authorize";
  const providerName = provider === "vercel" ? "Vercel" : "GitHub";
  const title = authorizing
    ? "Authorize GitHub connection"
    : `Connect to ${providerName}`;
  const actionLabel = authorizing
    ? "Authorize emulated GitHub"
    : `Connect emulated ${providerName}`;
  const environment =
    emulation.mode === "preview"
      ? ("Preview deployment" as const)
      : ("Local development" as const);
  const details =
    provider === "github"
      ? [
          { label: "Organization", value: "Autograph Local" },
          { label: "Repository", value: emulation.githubRepository },
        ]
      : [
          { label: "Team", value: "Autograph Local" },
          {
            label: "Team slug",
            value:
              process.env.EMULATE_VERCEL_TEAM_ID ?? EMULATED_VERCEL_TEAM_ID,
          },
          {
            label: "Configuration",
            value:
              process.env.EMULATE_VERCEL_CONFIGURATION_ID ??
              EMULATED_VERCEL_CONFIGURATION_ID,
          },
        ];
  const forwarded = authorizing
    ? ["client_id", "redirect_uri", "code_challenge", "code_challenge_method"]
    : [];
  return (
    <EmulationApproval
      provider={typedProvider}
      environment={environment}
      title={title}
      description={`Approve the seeded ${providerName} identity for this App Builder workspace.`}
      account="Autograph Developer"
      handle={provider === "github" ? "@autograph-dev" : "autograph-dev"}
      details={details}
      scope={
        provider === "github"
          ? "Access is limited to the seeded GitHub App installation and repository shown above."
          : "Access is limited to the seeded Vercel team and integration configuration shown above."
      }
      actionLabel={actionLabel}
      backHref={resumeKey ? `/?resume=${encodeURIComponent(resumeKey)}` : "/"}
      action={
        <form method="post" action={`/local-connections/${provider}/complete`}>
          <input type="hidden" name="state" value={query.state} />
          {authorizing ? (
            <input type="hidden" name="phase" value="authorize" />
          ) : null}
          {forwarded.map((name) =>
            typeof query[name] === "string" ? (
              <input key={name} type="hidden" name={name} value={query[name]} />
            ) : null,
          )}
          <button className={emulationApprovalStyles.button} type="submit">
            {actionLabel}
          </button>
        </form>
      }
    />
  );
}
