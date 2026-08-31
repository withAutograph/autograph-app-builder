import { notFound } from "next/navigation";

import {
  EmulationApproval,
  emulationApprovalStyles,
} from "@/app/ui/emulation-approval";
import {
  localOAuthProviderDetails,
  parseLocalOAuthAuthorization,
  signFreshLocalOAuthApproval,
} from "@/lib/auth/local-oauth-approval";
import {
  readProviderEmulation,
  type ProviderEmulation,
} from "@/lib/integrations/local-provider-emulation";

type Props = {
  params: Promise<{ provider: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

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
  const approval = signFreshLocalOAuthApproval(
    {
      provider: parsed.provider,
      origin: emulation.canonicalOrigin,
      authorization: parsed.authorization,
    },
    emulation.relaySecret,
  );
  const environment =
    emulation.mode === "preview"
      ? ("Preview deployment" as const)
      : ("Local development" as const);
  const actionLabel = `Continue with ${details.name}`;

  return (
    <EmulationApproval
      provider={parsed.provider}
      environment={environment}
      title={actionLabel}
      description={`Authorize Autograph App Builder to use your emulated ${details.name} identity.`}
      account={details.account}
      handle={details.handle}
      details={[]}
      scope={details.scope}
      actionLabel={actionLabel}
      action={
        emulation.mode === "preview" ? (
          <a
            className={emulationApprovalStyles.button}
            href={`/local-oauth/${parsed.provider}/approve/${approval}`}
          >
            {actionLabel}
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
            <button className={emulationApprovalStyles.button} type="submit">
              {actionLabel}
            </button>
          </form>
        )
      }
    />
  );
}
