"use client";

import { useActionState, useState } from "react";
import { DeployToSection, StoreInSection } from "./builder-provider-controls";
import type { selectBuilderSessionDestination } from "../actions/builder-session-destination";
import type { BuilderSessionDestinationActionState } from "../../lib/provisioning/builder-session-destination-action";
import type { openBuilderSessionDestination } from "../../lib/provisioning/builder-session-destination-deployment";

type PageData = Awaited<
  ReturnType<Awaited<ReturnType<typeof openBuilderSessionDestination>>["readPage"]>
>;

const connect = () => {
  window.location.assign("/");
};
const fixedProvider = (): void => {
  // The existing provider panels are fixed to the supported GitHub/Vercel choices.
};
const initialDestination = (props: PageData) => ({
  github: props.request?.providers.githubInstallationId ?? "",
  privateRepository: props.request?.repository.private ?? true,
  repository: props.request?.repository.name ?? props.appId,
  vercel: props.request?.providers.vercelInstallationId ?? "",
});
export const SavedSessionDestinationForm = (
  props: PageData & { requestId: string; submit: typeof selectBuilderSessionDestination },
) => {
  const initial = initialDestination(props);
  const [github, setGithub] = useState(initial.github);
  const [vercel, setVercel] = useState(initial.vercel);
  const [repository, setRepository] = useState(initial.repository);
  const [privateRepository, setPrivate] = useState(initial.privateRepository);
  const [state, action, pending] = useActionState<BuilderSessionDestinationActionState, FormData>(
    async () =>
      await props.submit({
        expected: props.expected,
        request:
          props.request === undefined
            ? {
                appName: props.appId,
                deploymentAccess: "public-app",
                operation: "vercel",
                providers: { githubInstallationId: github, vercelInstallationId: vercel },
                repository: { name: repository, private: privateRepository },
                requestId: props.requestId,
                version: 1,
              }
            : { ...props.request, operation: "vercel" },
        sessionId: props.sessionId,
      }),
    { status: "idle" },
  );
  const available = props.enabled && props.selectable && props.request === undefined && !pending;

  if (props.ready || state.status === "ready") {
    return (
      <p role="status">Your app destination is ready. Return to the saved build to continue.</p>
    );
  }
  const buttonDisabled = [
    pending,
    !props.enabled,
    !props.selectable,
    props.request === undefined && (github.length === 0 || vercel.length === 0),
  ].some(Boolean);
  let buttonLabel = "Create app destination";
  if (props.request !== undefined) {
    buttonLabel = "Continue saved destination";
  }
  if (pending) {
    buttonLabel = "Setting up destination…";
  }
  return (
    <form action={action}>
      <fieldset disabled={!available}>
        <StoreInSection
          available
          connected={props.github.length > 0}
          gitScope={github}
          gitScopeOptions={props.github.map((scope) => ({
            label: scope.accountLogin,
            value: scope.installationId,
          }))}
          onConnect={connect}
          onGitScopeChange={setGithub}
          onPrivacyChange={setPrivate}
          onProviderChange={fixedProvider}
          onRepositoryChange={setRepository}
          privateRepository={privateRepository}
          repository={repository}
          selected="github"
        />
        <DeployToSection
          available
          connected={props.vercel.length > 0}
          onConnect={connect}
          onProviderChange={fixedProvider}
          onTeamChange={setVercel}
          selected="vercel"
          team={vercel}
          teamOptions={props.vercel.map((scope) => ({
            label: scope.displayName,
            value: scope.installationId,
          }))}
        />
      </fieldset>
      <p>
        This creates the selected repository and app deployment project. It preserves this build and
        does not activate a data provider.
      </p>
      <button type="submit" disabled={buttonDisabled}>
        {buttonLabel}
      </button>
      {state.message === undefined ? null : <p role="status">{state.message}</p>}
      {props.selectable ? null : (
        <p>Finish the current build question or operation before selecting its destination.</p>
      )}
      {props.enabled ? null : (
        <p>Destination setup is unavailable. Your saved build is preserved.</p>
      )}
    </form>
  );
};
