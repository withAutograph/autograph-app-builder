import { BuilderPublicOriginForm } from "@/app/ui/builder-public-origin-form";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { openBuilderSessionDestination } from "@/lib/provisioning/builder-session-destination-deployment";
import {
  selectBuilderSessionPublicOrigin,
  selectBuilderSessionDestination,
} from "@/app/actions/builder-session-destination";
import { SavedSessionDestinationForm } from "@/app/ui/saved-session-destination-form";

export default async function SavedSessionDestinationPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const [{ sessionId }, incoming] = await Promise.all([params, headers()]);
  const context = await openBuilderSessionDestination(new Headers(incoming));
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
        {...data}
        requestId={data.request?.requestId ?? randomUUID()}
      />
    </main>
  );
}
