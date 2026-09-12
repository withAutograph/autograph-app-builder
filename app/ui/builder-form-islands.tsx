"use client";

import {
  useBuilderControllerContext,
  ModelControls,
  StoreInSection,
  DeployToSection,
  ConnectionsSection,
} from "./app-builder";
import { AppDetailsSection } from "./builder-app-details";
import { BuildWithSection } from "./builder-destination";
import { ProviderNotices } from "./builder-shell";
import styles from "./app-builder.module.css";

export function BuilderDraftStatus() {
  const { draftSaveError, draftSyncNotice, autosave, setDraftSaveError } =
    useBuilderControllerContext();
  return (
    <p className={styles.draftStatus} role="status" aria-live="polite">
      {draftSaveError ||
        draftSyncNotice ||
        (autosave.status === "saving"
          ? "Saving your draft…"
          : autosave.status === "saved"
            ? "Draft saved"
            : autosave.status === "offline"
              ? "Offline — your draft will retry when you’re back online."
              : autosave.status === "error"
                ? "Your latest edit is safe on this device and will retry."
                : "Your draft saves automatically.")}
      {autosave.status === "error" || draftSaveError ? (
        <button
          type="button"
          className={styles.draftRetry}
          onClick={() => {
            setDraftSaveError("");
            void autosave.retry();
          }}
        >
          Retry
        </button>
      ) : null}
    </p>
  );
}

export function BuilderProviderNotices() {
  const { visibleProviderNotices } = useBuilderControllerContext();
  return <ProviderNotices notices={visibleProviderNotices} />;
}

export function BuilderAppDetails() {
  const {
    form,
    builderForm,
    appNameEditedByUser,
    generatedAppName,
    setForm,
    repositoryEditedByUser,
    updateBrief,
    briefExamples,
    repositoryNameFromAppName,
  } = useBuilderControllerContext();
  return (
    <AppDetailsSection
      bare
      appName={form.appName}
      brief={form.brief}
      appNameRegistration={builderForm.register("appName")}
      briefRegistration={builderForm.register("brief")}
      onAppNameChange={(appName) => {
        appNameEditedByUser.current = true;
        generatedAppName.current = undefined;
        setForm((current) => ({
          ...current,
          appName,
          repository: repositoryEditedByUser.current
            ? current.repository
            : repositoryNameFromAppName(appName),
        }));
      }}
      onBriefChange={updateBrief}
      onCycleBrief={() => {
        const currentIndex = briefExamples.indexOf(form.brief as (typeof briefExamples)[number]);
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % briefExamples.length;
        updateBrief(briefExamples[nextIndex]);
      }}
    />
  );
}

export function BuilderDestination() {
  const { comingSoonEnabled, form, setForm } = useBuilderControllerContext();
  return (
    <BuildWithSection
      bare
      comingSoonEnabled={comingSoonEnabled}
      selected={form.buildDestination}
      onChange={(buildDestination) => setForm((current) => ({ ...current, buildDestination }))}
    />
  );
}

export function BuilderModel() {
  const { form, integrations, model, modelOptions, zdrOnly, setModel, setZdrOnly, router } =
    useBuilderControllerContext();
  return form.buildDestination === "web" ? (
    <ModelControls
      available={integrations.models.status === "ready"}
      model={model}
      options={modelOptions}
      zdrOnly={zdrOnly}
      onModelChange={(value) => {
        setModel(value);
      }}
      onZdrChange={(checked) => {
        setZdrOnly(checked);
        if (
          checked &&
          !integrations.models.entries.some((entry) => entry.id === model && entry.zdr === "all")
        )
          setModel("");
      }}
      onRetry={() => router.refresh()}
    />
  ) : null;
}

export function BuilderStorage() {
  const {
    integrations,
    comingSoonEnabled,
    storageProvider,
    gitScope,
    gitScopeOptions,
    form,
    setStorageProvider,
    setGitScope,
    repositoryEditedByUser,
    setForm,
    beginProviderConnection,
  } = useBuilderControllerContext();
  return (
    <StoreInSection
      bare
      available={integrations.github.status !== "unavailable"}
      comingSoonEnabled={comingSoonEnabled}
      connected={integrations.github.status === "connected"}
      selected={storageProvider}
      gitScope={gitScope}
      gitScopeOptions={gitScopeOptions}
      repository={form.repository}
      privateRepository={form.privateRepository}
      onProviderChange={(provider) => {
        setStorageProvider((current) => (current === provider ? null : provider));
      }}
      onGitScopeChange={(value) => {
        setGitScope(value);
      }}
      onRepositoryChange={(repository) => {
        repositoryEditedByUser.current = true;
        setForm((current) => ({ ...current, repository }));
      }}
      onPrivacyChange={(privateRepository) => {
        setForm((current) => ({ ...current, privateRepository }));
      }}
      onConnect={() => beginProviderConnection("github")}
    />
  );
}

export function BuilderDeployment() {
  const {
    integrations,
    comingSoonEnabled,
    deploymentProvider,
    team,
    teamOptions,
    setDeploymentProvider,
    setTeam,
    beginProviderConnection,
  } = useBuilderControllerContext();
  return (
    <DeployToSection
      bare
      available={integrations.vercel.status !== "unavailable"}
      comingSoonEnabled={comingSoonEnabled}
      connected={integrations.vercel.status === "connected"}
      selected={deploymentProvider}
      team={team}
      teamOptions={teamOptions}
      onProviderChange={(provider) => {
        setDeploymentProvider((current) => (current === provider ? null : provider));
      }}
      onTeamChange={(value) => {
        setTeam(value);
      }}
      onConnect={() => beginProviderConnection("vercel")}
    />
  );
}

export function BuilderConnections() {
  const {
    connectedConnections,
    comingSoonEnabled,
    search,
    form,
    showMoreConnections,
    addConnection,
    removeConnection,
    setSearch,
    setShowMoreConnections,
    setConnectionFlow,
  } = useBuilderControllerContext();
  return (
    <ConnectionsSection
      bare
      connected={connectedConnections}
      comingSoonEnabled={comingSoonEnabled}
      search={search}
      selected={form.connections}
      showMore={showMoreConnections}
      onAdd={addConnection}
      onRemove={removeConnection}
      onSearchChange={setSearch}
      onShowMore={() => setShowMoreConnections(true)}
      onCustomize={(name) =>
        setConnectionFlow({
          name,
          stage: connectedConnections.includes(name) ? "configure" : "connect",
        })
      }
    />
  );
}

export function BuilderSubmit() {
  const { canSubmit, submitGuidance } = useBuilderControllerContext();
  return (
    <div className={styles.submitArea}>
      <button
        className={styles.createButton}
        type="submit"
        disabled={!canSubmit}
        aria-describedby={submitGuidance ? "create-app-guidance" : undefined}
      >
        Create App
      </button>
      {submitGuidance ? (
        <p className={styles.submitGuidance} id="create-app-guidance">
          {submitGuidance}
        </p>
      ) : null}
    </div>
  );
}
