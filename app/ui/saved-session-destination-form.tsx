"use client";

import { useActionState, useState } from "react";
import { DeployToSection, StoreInSection } from "./builder-provider-controls";
import type { selectBuilderSessionDestination } from "../actions/builder-session-destination";
import type { BuilderSessionDestinationActionState } from "../../lib/provisioning/builder-session-destination-action";
import type { openBuilderSessionDestination } from "../../lib/provisioning/builder-session-destination-deployment";

type DestinationPage = Awaited<
  ReturnType<Awaited<ReturnType<typeof openBuilderSessionDestination>>["readPage"]>
>;
type PageData = Omit<DestinationPage, "existingRepository"> & {
  existingRepository?: DestinationPage["existingRepository"];
  repositoryHint?: string;
};

const connect = () => {
  window.location.assign("/");
};
const fixedProvider = (): void => {
  // The existing provider panels are fixed to the supported GitHub/Vercel choices.
};
const initialDestination = (props: PageData) => ({
  github: props.request?.providers.githubInstallationId ?? "",
  vercel: props.request?.providers.vercelInstallationId ?? "",
  repository: props.request?.repository.name ?? props.appId,
  privateRepository: props.request?.repository.private ?? true,
});
const textField = (form: FormData, name: string): string => {
  const value = form.get(name);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- FormData can contain a File; only text fields may enter this typed action.
  return typeof value === "string" ? value : "";
};

const ExistingRepositoryForm = (
  props: PageData & { submit: typeof selectBuilderSessionDestination },
) => {
  const [state, action, pending] = useActionState<BuilderSessionDestinationActionState, FormData>(
    async (_previous, form) => {
      const installation = textField(form, "installation");
      const request: Parameters<typeof props.submit>[0] = {
        kind: "existing-repository",
        sessionId: props.sessionId,
        expected: props.expected,
        repository: textField(form, "repository"),
      };
      if (installation !== "") {
        request.selectedInstallationId = installation;
      }
      return await props.submit(request);
    },
    { status: "idle" },
  );
  return (
    <form action={action} aria-label="Use existing repository">
      <h2>Use an existing repository</h2>
      <label htmlFor="existing-delivery-repository">GitHub repository</label>
      <input
        id="existing-delivery-repository"
        name="repository"
        defaultValue={props.repositoryHint ?? ""}
        required
        placeholder="owner/name or GitHub repository URL"
        disabled={pending || !props.selectable}
      />
      {props.github.length > 1 ? (
        <label>
          GitHub account
          <select name="installation" disabled={pending || !props.selectable} defaultValue="">
            <option value="">Choose connected account</option>
            {props.github.map((scope) => (
              <option key={scope.installationId} value={scope.installationId}>
                {scope.accountLogin}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p>Builder uses the repository’s existing delivery setup.</p>
      <button type="submit" disabled={pending || !props.selectable}>
        {pending ? "Checking repository…" : "Use this repository"}
      </button>
      {state.message === undefined ? null : <p role="status">{state.message}</p>}
      {state.connectionUrl === undefined ? null : (
        <a href={state.connectionUrl}>Connect GitHub for this repository</a>
      )}
      {state.status === "ready" ? (
        <a href={`/builds/${encodeURIComponent(props.sessionId)}`}>Continue saved build</a>
      ) : null}
    </form>
  );
};

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
        sessionId: props.sessionId,
        expected: props.expected,
        request:
          props.request === undefined
            ? {
                version: 1,
                operation: "vercel",
                requestId: props.requestId,
                appName: props.appId,
                deploymentAccess: "public-app",
                repository: { name: repository, private: privateRepository },
                providers: { githubInstallationId: github, vercelInstallationId: vercel },
              }
            : { ...props.request, operation: "vercel" },
      }),
    { status: "idle" },
  );
  const available = props.enabled && props.selectable && props.request === undefined && !pending;

  if (props.existingRepository !== undefined) {
    const { owner, name } = props.existingRepository.repository;
    return (
      <section aria-label="Delivery repository">
        <p role="status">
          Delivery repository: {owner}/{name}
        </p>
        <p>
          Builder uses this repository’s existing app delivery. No new repository or project is
          created.
        </p>
        <a href={`/builds/${encodeURIComponent(props.sessionId)}`}>Continue saved build</a>
      </section>
    );
  }
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
    <>
      {props.request === undefined ? <ExistingRepositoryForm {...props} /> : null}
      <form action={action} aria-label="Create app destination">
        <fieldset disabled={!available}>
          <StoreInSection
            available
            connected={props.github.length > 0}
            gitScope={github}
            gitScopeOptions={props.github.map((scope) => ({
              value: scope.installationId,
              label: scope.accountLogin,
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
              value: scope.installationId,
              label: scope.displayName,
            }))}
          />
        </fieldset>
        <p>
          This creates the selected repository and app deployment project. It preserves this build
          and does not activate a data provider.
        </p>
        <button type="submit" disabled={buttonDisabled}>
          {buttonLabel}
        </button>
        {state.message === undefined ? null : <p role="status">{state.message}</p>}
        {props.selectable ? null : (
          <p>Finish the current build question or operation before selecting its destination.</p>
        )}
        {props.enabled ? null : (
          <p>
            Creating a new repository and deployment project is unavailable. You can use an existing
            repository above.
          </p>
        )}
      </form>
    </>
  );
};
