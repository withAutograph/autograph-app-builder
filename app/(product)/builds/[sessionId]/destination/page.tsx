import { BuilderPublicOriginForm } from "@/app/ui/builder-public-origin-form";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  BuilderSessionDestinationSignInRequiredError,
  openBuilderSessionDestination,
} from "@/lib/provisioning/builder-session-destination-deployment";
import {
  selectBuilderSessionPublicOrigin,
  selectBuilderSessionDestination,
} from "@/app/actions/builder-session-destination";
import { SavedSessionDestinationForm } from "@/app/ui/saved-session-destination-form";
import { parseRepositoryReference } from "@/lib/integrations/repository-access";
import { appAccessPath } from "@/lib/app-access/contracts";

export default async function SavedSessionDestinationPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ repository?: string }>;
}) {
  const [{ sessionId }, incoming, query] = await Promise.all([params, headers(), searchParams]);
  let repositoryHint;
  try {
    repositoryHint = parseRepositoryReference(query.repository ?? "").fullName;
  } catch {
    // A return hint is editable input, never repository authority.
  }
  let context;
  try {
    context = await openBuilderSessionDestination(new Headers(incoming));
  } catch (error) {
    if (!(error instanceof BuilderSessionDestinationSignInRequiredError)) {
      throw error;
    }
    const destination = `/builds/${encodeURIComponent(sessionId)}/destination`;
    redirect(`/auth/sign-in?callbackURL=${encodeURIComponent(destination)}`);
  }
  const data = await context.readPage(sessionId);
  let originChoice;
  if (data.ready) {
    try {
      originChoice = await context.publicOrigins.read(context.principal, sessionId);
    } catch {
      /* Existing provisioning remains visible when the separate domain read is unavailable. */
    }
  }
  return (
    <main>
      <h1>Publish {data.title}</h1>
      <p>
        <a href={appAccessPath(sessionId)}>Manage app access and people</a>
      </p>
      <p>
        Choose where Builder stores and deploys this saved app. Its public domain uses the app’s own
        sign-in.
      </p>
      {originChoice === undefined ? null : (
        <BuilderPublicOriginForm
          sessionId={sessionId}
          {...originChoice}
          submit={selectBuilderSessionPublicOrigin}
        />
      )}
      <SavedSessionDestinationForm
        key={data.request?.requestId ?? data.sessionId}
        submit={selectBuilderSessionDestination}
        repositoryHint={repositoryHint}
        {...data}
        requestId={data.request?.requestId ?? randomUUID()}
      />
    </main>
  );
}
