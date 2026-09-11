"use client";

import type {
  BuilderDraft,
  BuilderForm,
  DeploymentProvider,
  ProviderField,
  StorageProvider,
} from "./builder-types";

import {
  Check,
  ChevronDown,
  ExternalLink,
  Globe,
  Plus,
  PlusCircle,
  Search,
  X,
} from "@geist-ui/icons";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { FaGithub, FaLock, FaLockOpen } from "react-icons/fa";
import { useForm, useWatch } from "react-hook-form";
import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type SetStateAction,
} from "react";
import {
  SiBitbucket,
  SiCloudflare,
  SiGitlab,
  SiNetlify,
  SiQuickbooks,
  SiSage,
  SiVercel,
  SiXero,
} from "react-icons/si";

import type { BuilderIntegrationState } from "@/lib/integrations/builder-state";
import {
  builderDraftFormSchema,
  type BuilderDraftRecord,
  type BuilderDraftPageData,
  type SaveActiveBuilderDraftInput,
} from "@/lib/builder-drafts/contracts";
import { activeBuilderModelId } from "../../lib/integrations/active-model";
import { deriveBuilderAppId } from "../../lib/provisioning/names";
import { SectionShell } from "../../components/create-app/choice-card";
import { ProviderChoiceSection } from "../../components/create-app/provider-choice-section";
import styles from "./app-builder.module.css";
import autographIcon from "../../assets/autograph-icon.png";
import type { ProviderConnectionNotice } from "../../lib/integrations/provider-connection-status";
import { githubStoreInViewModel } from "../../lib/integrations/store-in-view-model";
import { ProviderNotices } from "./builder-shell";
import { createBuilderDraftOutbox } from "./builder-draft-outbox";
import { useBuilderDraftAutosave } from "./use-builder-draft-autosave";
import { AppDetailsSection } from "./builder-app-details";
import { BuildWithSection } from "./builder-destination";
import { InfoTooltip } from "./builder-info-tooltip";
import { SearchCombobox, type ComboOption } from "./search-combobox";
import { AutographMark } from "./autograph-mark";

export { AppDetailsSection } from "./builder-app-details";
export { BuildWithSection } from "./builder-destination";
export { InfoTooltip } from "./builder-info-tooltip";
export { AutographMark } from "./autograph-mark";
export type {
  BuilderDraft,
  BuilderForm,
  DeploymentProvider,
  ProviderField,
  StorageProvider,
} from "./builder-types";

export type ConnectionStage = "connect" | "configure" | "customize";
export type ConnectionFlow = { name: string; stage: ConnectionStage };

const featuredConnections = [
  ["QuickBooks", "quickbooks"],
  ["Ramp", "ramp"],
  ["NetSuite", "netsuite"],
  ["Xero", "xero"],
  ["Sage Intacct", "sage-intacct"],
] as const;

const allConnectionNames = featuredConnections.map(([name]) => name);
const comingSoonConnections = new Set(["Ramp", "NetSuite", "Xero", "Sage Intacct"]);

const connectionKind = new Map<string, string>(featuredConnections);

const storageProviderOptions = [
  { name: "GitHub", provider: "github", icon: FaGithub, available: true },
  { name: "GitLab", provider: "gitlab", icon: SiGitlab, available: false },
  {
    name: "Bitbucket",
    provider: "bitbucket",
    icon: SiBitbucket,
    available: false,
  },
] as const;

const deploymentProviderOptions = [
  { name: "Vercel", provider: "vercel", icon: SiVercel, available: true },
  { name: "Netlify", provider: "netlify", icon: SiNetlify, available: false },
  {
    name: "Cloudflare",
    provider: "cloudflare",
    icon: SiCloudflare,
    available: false,
  },
] as const;

const connectionDescriptions: Record<string, string> = {
  QuickBooks: "Import mapped vendors, bills, and vendor credits",
  Ramp: "Import authorized transactions and vendor data",
  NetSuite: "Import vendor data from a NetSuite account",
  Xero: "Import suppliers, invoices, and credit data",
  "Sage Intacct": "Import vendor data from a Sage Intacct company",
};

function connectionDescription(name: string) {
  return connectionDescriptions[name] ?? `Connect ${name} tools and data to your app`;
}

const defaultBrief =
  "# Product\n\nBuild a focused app that helps people complete one important workflow. Define the users, the desired outcome, the repository constraints, and the acceptance criteria. Match the requested product tone and interface, verify assumptions before building, and make the final checks explicit.";

function subscribeToClientSnapshot() {
  return () => {};
}

const briefExamples = [
  defaultBrief,
  "# Customer feedback portal\n\nBuild a portal where customers can submit feedback, vote on ideas, and follow status updates. Give the product team a triage view with tags, ownership, and clear acceptance criteria.",
  "# Operations dashboard\n\nBuild an internal dashboard for monitoring active work, blocked tasks, and service health. Prioritize fast scanning, clear ownership, and links to the source systems for follow-up.",
  "# Vendor onboarding\n\nBuild a guided vendor onboarding app that collects company details, validates required documents, and shows approval progress. Include explicit review states, responsible owners, and audit-friendly history.",
] as const;

const randomNameAdjectives = [
  "Adaptive",
  "Agile",
  "Bright",
  "Calm",
  "Clever",
  "Clear",
  "Curious",
  "Focused",
  "Grounded",
  "Guided",
  "Helpful",
  "Human",
  "Intentional",
  "Keen",
  "Lucid",
  "Modern",
  "Nimble",
  "Open",
  "Ready",
  "Reliable",
  "Simple",
  "Steady",
  "Swift",
  "Thoughtful",
  "Trusted",
  "Useful",
  "Warm",
] as const;
const randomNameNouns = [
  "App",
  "Atlas",
  "Beacon",
  "Blueprint",
  "Bridge",
  "Builder",
  "Canvas",
  "Compass",
  "Forge",
  "Foundry",
  "Flow",
  "Grove",
  "Harbor",
  "Launch",
  "Loom",
  "Orbit",
  "Path",
  "Pilot",
  "Portal",
  "Prism",
  "Relay",
  "Signal",
  "Spark",
  "Stack",
  "Studio",
  "Thread",
  "Waypoint",
  "Workshop",
] as const;
const preferredModelId = activeBuilderModelId;

export function repositoryNameFromAppName(appName: string) {
  return appName
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 100)
    .replaceAll(/-+$/gu, "");
}

export function appNameFromBrief(brief: string) {
  const firstContentLine = brief
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s*/u, "").trim())
    .find(Boolean);
  if (!firstContentLine) return "";

  const words = firstContentLine
    .replaceAll(/[*_`[\](){}]/gu, " ")
    .replace(/^(?:build|create|design|launch|make)\s+(?:an?\s+|the\s+)?/iu, "")
    .replaceAll(/[^\p{L}\p{N}'& -]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .slice(0, 5);
  return words
    .map((word) =>
      word.length > 1
        ? `${word[0]?.toUpperCase()}${word.slice(1).toLowerCase()}`
        : word.toUpperCase(),
    )
    .join(" ")
    .slice(0, 120)
    .replace(/[\uD800-\uDBFF]$/u, "")
    .trimEnd();
}

function randomAppName(seed?: string) {
  if (!seed) {
    const adjective = randomNameAdjectives[Math.floor(Math.random() * randomNameAdjectives.length)];
    const noun = randomNameNouns[Math.floor(Math.random() * randomNameNouns.length)];
    return `${adjective} ${noun}`;
  }
  const hash = [...seed].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  const adjective = randomNameAdjectives[hash % randomNameAdjectives.length];
  const noun =
    randomNameNouns[Math.floor(hash / randomNameAdjectives.length) % randomNameNouns.length];
  return `${adjective} ${noun}`;
}

export function ConnectionIcon({ kind, name }: { kind?: string; name: string }) {
  const icons = {
    quickbooks: SiQuickbooks,
    xero: SiXero,
    "sage-intacct": SiSage,
  };
  const Icon = kind ? icons[kind as keyof typeof icons] : undefined;
  const hasBrandAsset = kind === "ramp" || kind === "netsuite";
  return (
    <span className={styles.connectionIcon} data-kind={kind} data-name={name} aria-hidden="true">
      {Icon ? <Icon size={18} /> : hasBrandAsset ? null : <Globe size={18} />}
    </span>
  );
}

export function ModelControls({
  available,
  model,
  onModelChange,
  onRetry,
  onZdrChange,
  options,
  zdrOnly,
}: {
  available: boolean;
  model: string;
  onModelChange: (value: string) => void;
  onRetry: () => void;
  onZdrChange: (value: boolean) => void;
  options: ComboOption[];
  zdrOnly: boolean;
}) {
  return (
    <fieldset className={styles.modelField}>
      <legend>Model</legend>
      <label className={styles.checkLine}>
        <input
          type="checkbox"
          name="zdr"
          checked={zdrOnly}
          onChange={(event) => onZdrChange(event.target.checked)}
        />{" "}
        Zero Data Retention
        <InfoTooltip>Only use providers that support Zero Data Retention.</InfoTooltip>
      </label>
      <SearchCombobox
        label={options.find((option) => option.value === model)?.label ?? "Select model"}
        value={model}
        options={options}
        onChange={onModelChange}
        placeholder={available ? "Select model" : "Models unavailable"}
        disabled={!available}
        prefix={<Search size={15} />}
        showSelectedCheck={false}
      />
      {!available ? (
        <button className={styles.retryModels} type="button" onClick={onRetry}>
          Retry models
        </button>
      ) : null}
    </fieldset>
  );
}

export function DeployToSection({
  available,
  comingSoonEnabled = false,
  connected,
  onConnect,
  onProviderChange,
  onTeamChange,
  selected,
  team,
  teamOptions,
}: {
  available: boolean;
  comingSoonEnabled?: boolean;
  connected: boolean;
  onConnect: () => void;
  onProviderChange: (provider: DeploymentProvider) => void;
  onTeamChange: (value: string) => void;
  selected: DeploymentProvider | null;
  team: string;
  teamOptions: ComboOption[];
}) {
  return (
    <ProviderChoiceSection
      className={`${styles.sectionField} ${styles.deploySection}`}
      section="deploy-to"
      title="Deploy to"
      description="Where do you want to deploy this app?"
      label="Deployment provider"
      name="deployment-provider"
      gridClassName={`${styles.optionGrid} ${styles.providerChoiceGrid}`}
      unavailableClassName={styles.unavailableOption}
      options={deploymentProviderOptions
        .map((option) => ({
          ...option,
          available: option.available && available,
        }))
        .filter((option) => comingSoonEnabled || option.available)}
      selected={selected}
      onChange={onProviderChange}
    >
      {selected === "vercel" && available ? (
        <div className={styles.providerPanel} id="deployment-provider-vercel">
          <div className={styles.integrationField}>
            <span className={styles.fieldLabel}>
              Vercel Team <small aria-hidden="true">Optional</small>
            </span>
            {connected ? (
              <SearchCombobox
                label="Select a Vercel Team"
                value={team}
                options={teamOptions}
                onChange={onTeamChange}
                inputId="vercel-team"
                prefix={<span className={styles.teamDot} data-team={team} />}
                optionIcon={(option) => (
                  <span className={styles.teamDot} data-team={option.value} />
                )}
                footerIcon={<PlusCircle size={18} />}
                detailPills
                menuFooter={{
                  value: "create-team",
                  label: "Connect another Vercel team",
                }}
                onFooterSelect={onConnect}
              />
            ) : (
              <button
                className={styles.connectProvider}
                type="button"
                id="vercel-team"
                onClick={onConnect}
              >
                Connect to Vercel
              </button>
            )}
          </div>
        </div>
      ) : null}
    </ProviderChoiceSection>
  );
}

export function StoreInSection({
  available,
  comingSoonEnabled = false,
  connected,
  gitScope,
  gitScopeOptions,
  onConnect,
  onGitScopeChange,
  onPrivacyChange,
  onProviderChange,
  onRepositoryChange,
  privateRepository,
  repository,
  selected,
}: {
  available: boolean;
  comingSoonEnabled?: boolean;
  connected: boolean;
  gitScope: string;
  gitScopeOptions: ComboOption[];
  onConnect: () => void;
  onGitScopeChange: (value: string) => void;
  onPrivacyChange: (value: boolean) => void;
  onProviderChange: (provider: StorageProvider) => void;
  onRepositoryChange: (value: string) => void;
  privateRepository: boolean;
  repository: string;
  selected: StorageProvider | null;
}) {
  const githubView = githubStoreInViewModel({
    action: connected ? "update" : "connect",
    scopes: gitScopeOptions.map((scope) => ({
      id: scope.value,
      label: scope.label,
      ...(scope.detail === undefined ? {} : { detail: scope.detail }),
    })),
  });
  return (
    <ProviderChoiceSection
      className={`${styles.sectionField} ${styles.storeSection}`}
      section="store-in"
      title="Store in"
      description="Where do you want to store this app?"
      label="Storage provider"
      name="storage-provider"
      gridClassName={`${styles.optionGrid} ${styles.providerChoiceGrid}`}
      unavailableClassName={styles.unavailableOption}
      options={storageProviderOptions
        .map((option) => ({
          ...option,
          available: option.available && available,
        }))
        .filter((option) => comingSoonEnabled || option.available)}
      selected={selected}
      onChange={onProviderChange}
    >
      {selected === "github" && available ? (
        <div className={styles.providerPanel} id="storage-provider-github">
          <div className={styles.repoScope}>
            <div className={`${styles.repoRow} ${gitScope ? styles.repoRowWithRepository : ""}`}>
              <div className={styles.integrationField}>
                <span className={styles.fieldLabel}>
                  Git Scope <small aria-hidden="true">Optional</small>
                </span>
                {connected ? (
                  <SearchCombobox
                    label="Git Scope"
                    value={gitScope}
                    options={gitScopeOptions}
                    onChange={onGitScopeChange}
                    inputId="git-scope"
                    prefix={<FaGithub size={16} />}
                    optionIcon={() => <FaGithub size={16} />}
                    footerIcon={<Plus size={21} />}
                    menuFooter={{
                      value: "add-github",
                      label: githubView.actionLabel,
                    }}
                    onFooterSelect={onConnect}
                  />
                ) : (
                  <button
                    className={styles.connectProvider}
                    type="button"
                    id="git-scope"
                    onClick={onConnect}
                  >
                    {githubView.actionLabel}
                  </button>
                )}
              </div>
              {gitScope ? (
                <>
                  <span className={styles.slash} aria-hidden="true">
                    /
                  </span>
                  <div className={styles.repoLabel}>
                    <span className={styles.fieldLabel}>
                      {privateRepository ? "Private" : "Public"} Repository Name{" "}
                      <small aria-hidden="true">Optional</small>
                    </span>
                    <div className={styles.lockedInput}>
                      <input
                        id="repository-name"
                        name="repository-name"
                        autoComplete="off"
                        spellCheck={false}
                        value={repository}
                        onChange={(event) => onRepositoryChange(event.target.value)}
                        placeholder="my-app"
                      />
                      <label className={styles.privacyToggle} aria-label="Private repository">
                        <input
                          type="checkbox"
                          checked={privateRepository}
                          onChange={(event) => onPrivacyChange(event.target.checked)}
                        />
                        <span>
                          <i>
                            {privateRepository ? <FaLock size={11} /> : <FaLockOpen size={12} />}
                          </i>
                        </span>
                        <em role="tooltip">
                          This repository will be {privateRepository ? "private" : "public"}.
                        </em>
                      </label>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </ProviderChoiceSection>
  );
}

export function ConnectionsSection({
  connected,
  comingSoonEnabled = false,
  onAdd,
  onCustomize,
  onRemove,
  onSearchChange,
  onShowMore,
  search,
  selected,
  showMore,
}: {
  connected: string[];
  comingSoonEnabled?: boolean;
  onAdd: (name: string) => void;
  onCustomize: (name: string) => void;
  onRemove: (name: string) => void;
  onSearchChange: (value: string) => void;
  onShowMore: () => void;
  search: string;
  selected: string[];
  showMore: boolean;
}) {
  const normalizedSearch = search.trim().toLowerCase();
  const available = (
    showMore || normalizedSearch ? allConnectionNames : allConnectionNames.slice(0, 2)
  ).filter((name) => !normalizedSearch || name.toLowerCase().includes(normalizedSearch));
  return (
    <SectionShell
      className={`${styles.sectionField} ${styles.connectionsSection}`}
      section="connections"
      title="Connections"
      description="Give this app access to tools and data from other services."
    >
      <label className={styles.searchBox}>
        <Search size={15} aria-hidden="true" />
        <span className={styles.srOnly}>Search connections</span>
        <input
          type="search"
          name="connection-search"
          autoComplete="off"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && onSearchChange("")}
          placeholder="Search connections…"
        />
        {search ? (
          <button type="button" onClick={() => onSearchChange("")}>
            Esc
          </button>
        ) : null}
      </label>
      <div className={styles.connectionGrid}>
        {available
          .filter((name) => !selected.includes(name))
          .map((name) => {
            const comingSoon = comingSoonConnections.has(name);
            if (comingSoon && !comingSoonEnabled) return null;
            return (
              <button
                type="button"
                key={name}
                aria-label={comingSoon ? `${name} coming soon` : `Add ${name}`}
                disabled={comingSoon}
                onClick={() => onAdd(name)}
              >
                <ConnectionIcon kind={connectionKind.get(name)} name={name} />
                {name}
                {comingSoon ? <span className={styles.comingSoon}>Coming soon</span> : null}
              </button>
            );
          })}
      </div>
      {!showMore && !search ? (
        <button className={styles.showAll} type="button" onClick={onShowMore}>
          Show more connections
        </button>
      ) : null}
      {selected.length ? (
        <div className={styles.connectedList} aria-label="Added connections">
          {selected.map((name) => (
            <article key={name}>
              <span>
                <ConnectionIcon kind={connectionKind.get(name)} name={name} />
              </span>
              <div>
                <strong>{name}</strong>
                <p>{connectionDescription(name)}</p>
              </div>
              <button type="button" onClick={() => onCustomize(name)}>
                {connected.includes(name) ? "Customize" : "Connect"}
              </button>
              <button type="button" aria-label={`Remove ${name}`} onClick={() => onRemove(name)}>
                <X size={17} />
              </button>
            </article>
          ))}
        </div>
      ) : null}
    </SectionShell>
  );
}

export function ConnectionDrawer({
  flow,
  onClose,
  onStageChange,
  onConnected,
}: {
  flow: ConnectionFlow;
  onClose: () => void;
  onStageChange: (stage: ConnectionStage) => void;
  onConnected: () => void;
}) {
  const [showSuccess, setShowSuccess] = useState(false);
  const [connectionName, setConnectionName] = useState(
    flow.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
  );
  const [description, setDescription] = useState(connectionDescription(flow.name));
  const accountLabel = flow.name === "Slack" ? "Slack Workspace" : "Account";

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  if (showSuccess)
    return (
      <div className={styles.connectionSuccess} role="dialog" aria-modal="true">
        <div>
          <h2>Connection successful</h2>
          <p>You can close this window and return to where you started.</p>
          <span aria-hidden="true">
            <Check size={20} />
          </span>
          <button
            type="button"
            onClick={() => {
              setShowSuccess(false);
              onStageChange("configure");
            }}
          >
            Return
          </button>
        </div>
      </div>
    );

  return (
    <div className={styles.drawerBackdrop} onMouseDown={onClose}>
      <div
        className={styles.connectionDrawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-drawer-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="connection-drawer-title">Add Connection</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className={styles.drawerProvider}>
          <ConnectionIcon kind={connectionKind.get(flow.name)} name={flow.name} />
          <strong>{flow.name}</strong>
        </div>

        <section className={styles.connectionStep} data-active="true">
          <h3>
            <span>2</span> Configure
          </h3>
          {flow.stage === "connect" ? (
            <div className={styles.connectPrompt}>
              <div className={styles.connectionMarks} aria-hidden="true">
                <span>
                  <ConnectionIcon kind={connectionKind.get(flow.name)} name={flow.name} />
                </span>
                <span>
                  <Image src={autographIcon} width={28} height={28} alt="" />
                </span>
              </div>
              <h4>Connect your {flow.name} account</h4>
              <p>Authorize Autograph to access {flow.name} on your behalf.</p>
              <button type="button" onClick={() => setShowSuccess(true)}>
                Connect {flow.name} <ExternalLink size={14} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className={styles.configureFields}>
              <label>
                {accountLabel}
                <button type="button" className={styles.accountSelect}>
                  <ConnectionIcon kind={connectionKind.get(flow.name)} name={flow.name} />
                  Autograph
                  <ChevronDown size={16} aria-hidden="true" />
                </button>
              </label>
              <label>
                <span>
                  Connection Name <em>*</em>
                </span>
                <input
                  value={connectionName}
                  onChange={(event) => setConnectionName(event.target.value)}
                />
              </label>
              <div className={styles.scopeRow}>
                <span>
                  App Permissions
                  <small>Permissions granted to this app.</small>
                </span>
                <button type="button">
                  Recommended <ChevronDown size={16} />
                </button>
              </div>
              <footer>
                <button
                  type="button"
                  disabled={!connectionName.trim()}
                  onClick={() => onStageChange("customize")}
                >
                  Continue
                </button>
              </footer>
            </div>
          )}
        </section>

        <section
          className={styles.connectionStep}
          data-active={flow.stage === "customize" || undefined}
        >
          <h3>
            <span>3</span> Customize
          </h3>
          {flow.stage === "customize" ? (
            <div className={styles.configureFields}>
              <label>
                Display Name
                <input
                  value={connectionName}
                  onChange={(event) => setConnectionName(event.target.value)}
                />
              </label>
              <label>
                Description
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label className={styles.defaultConnection}>
                <span>
                  Use as default
                  <small>Prefer this connection when {flow.name} is used.</small>
                </span>
                <input type="checkbox" />
              </label>
              <footer>
                <button type="button" onClick={onConnected}>
                  Add Connection
                </button>
              </footer>
            </div>
          ) : null}
        </section>
        <p className={styles.connectionTerms}>
          This connection is prepared locally. External authorization and credentials are not stored
          by this prototype.
        </p>
      </div>
    </div>
  );
}

export function Builder({
  initialBrief,
  generatedNameSeed,
  onCreate,
  connectionsEnabled,
  comingSoonEnabled,
  integrations,
  providerNotices,
  initialDraft,
  resumeKey,
  durableDraftId,
  durableDraftRevision = 0,
  durableDraftUpdatedAt,
  saveActiveBuilderDraftAction,
  loadActiveBuilderDraftAction,
}: {
  initialBrief: string;
  generatedNameSeed: string;
  onCreate: (form: BuilderForm, resumeKey?: string) => void;
  connectionsEnabled: boolean;
  comingSoonEnabled: boolean;
  integrations: BuilderIntegrationState;
  providerNotices: ProviderConnectionNotice[];
  initialDraft?: BuilderDraft;
  resumeKey?: string;
  durableDraftId?: string;
  durableDraftRevision?: number;
  durableDraftUpdatedAt?: string;
  saveActiveBuilderDraftAction?: (
    input: SaveActiveBuilderDraftInput,
  ) => Promise<{ draftId: string; revision: number; updatedAt: string }>;
  loadActiveBuilderDraftAction?: () => Promise<BuilderDraftPageData | undefined>;
}) {
  const router = useRouter();
  const teamOptions = integrations.vercel.scopes.map((scope) => ({
    value: scope.installationId,
    label: scope.displayName,
    detail: scope.plan === "unknown" ? "Connected" : scope.plan,
  }));
  const gitScopeOptions = integrations.github.scopes.map((scope) => ({
    value: scope.installationId,
    label: scope.accountLogin,
    detail: scope.accountType,
  }));
  const allModelOptions = integrations.models.entries
    .filter((model) => model.id === preferredModelId)
    .map((model) => ({
      value: model.id,
      label: model.name,
      detail: model.id,
    }));
  const defaultModel = allModelOptions[0]?.value ?? "";
  const effectiveInitialBrief = initialBrief.trim() ? initialBrief : defaultBrief;
  const initialAppName =
    appNameFromBrief(effectiveInitialBrief) || randomAppName(generatedNameSeed);
  const initialForm: BuilderForm = initialDraft
    ? {
        ...initialDraft.form,
        buildDestination: initialDraft.form.buildDestination ?? "codex",
      }
    : {
        appName: initialAppName,
        repository: repositoryNameFromAppName(initialAppName),
        brief: effectiveInitialBrief,
        privateRepository: true,
        buildDestination: "codex",
        connections: [],
        modelId: defaultModel,
      };
  const builderForm = useForm<BuilderForm>({
    defaultValues: initialForm,
    mode: "onChange",
    resolver: zodResolver(builderDraftFormSchema),
  });
  const form = useWatch({
    control: builderForm.control,
    defaultValue: initialForm,
  }) as BuilderForm;
  // RHF remains the form owner. This ref is only its synchronous mutation
  // mirror for action boundaries: a provider click can immediately follow an
  // input event while React is still publishing useWatch's render update.
  // Reading this mirror prevents a checkpoint from observing the prior field
  // value during that narrow window.
  const formSnapshot = useRef<BuilderForm>(initialForm);
  const localFormMutationVersion = useRef(0);
  const setForm = useCallback(
    (update: SetStateAction<BuilderForm>) => {
      localFormMutationVersion.current += 1;
      const current = formSnapshot.current;
      const next = typeof update === "function" ? update(current) : update;
      formSnapshot.current = next;
      (Object.keys(next) as Array<keyof BuilderForm>).forEach((field) => {
        // RHF publishes each setValue to useWatch independently. Replaying an
        // unchanged field from an older composite snapshot can otherwise
        // arrive after a later input event and overwrite it (for example, a
        // generated name replacing a manually edited name before OAuth).
        if (Object.is(current[field], next[field])) return;
        builderForm.setValue(field, next[field], {
          shouldDirty: true,
          shouldValidate: true,
        });
      });
    },
    [builderForm],
  );
  const appNameEditedByUser = useRef(initialDraft?.appNameEditedByUser ?? false);
  // Keep the provenance of an inferred name separate from the persisted
  // marker. A streamed action acknowledgement can briefly replay an older
  // marker while RHF already holds a user-entered name; that acknowledgement
  // must not turn the next brief edit into an instruction to replace it.
  const generatedAppName = useRef<string | undefined>(
    initialDraft?.appNameEditedByUser ? undefined : initialForm.appName,
  );
  const repositoryEditedByUser = useRef(initialDraft?.repositoryEditedByUser ?? false);
  const [initialActiveDraftId] = useState(() => resumeKey ?? durableDraftId ?? crypto.randomUUID());
  const activeDraftId = useRef(initialActiveDraftId);
  const resumedVercelConnection = providerNotices.some(
    (notice) => notice.provider === "vercel" && notice.status === "connected",
  );
  const resumedGitHubConnection = providerNotices.some(
    (notice) => notice.provider === "github" && notice.status === "connected",
  );
  const [team, setTeam] = useState(
    resumedVercelConnection
      ? (teamOptions[0]?.value ?? "")
      : (initialDraft?.team ?? teamOptions[0]?.value ?? ""),
  );
  const [gitScope, setGitScope] = useState(
    resumedGitHubConnection
      ? (gitScopeOptions[0]?.value ?? "")
      : (initialDraft?.gitScope ?? gitScopeOptions[0]?.value ?? ""),
  );
  const [model, setModel] = useState(defaultModel);
  const [zdrOnly, setZdrOnly] = useState(initialDraft?.zdrOnly ?? false);
  const [showMoreConnections, setShowMoreConnections] = useState(
    initialDraft?.showMoreConnections ?? false,
  );
  const [search, setSearch] = useState(initialDraft?.search ?? "");
  const [connectionFlow, setConnectionFlow] = useState<ConnectionFlow | null>(null);
  const clientHydrated = useSyncExternalStore(
    subscribeToClientSnapshot,
    () => true,
    () => false,
  );
  const [draftRecoveryComplete, setDraftRecoveryComplete] = useState(false);
  const interactive = clientHydrated && draftRecoveryComplete;
  const [connectedConnections, setConnectedConnections] = useState<string[]>(
    initialDraft?.connectedConnections ?? [],
  );
  const [storageProvider, setStorageProvider] = useState<StorageProvider | null>(
    initialDraft?.storageProvider === null ? null : "github",
  );
  const [deploymentProvider, setDeploymentProvider] = useState<DeploymentProvider | null>(
    initialDraft?.deploymentProvider === "vercel" ? "vercel" : null,
  );
  const draftRevision = useRef(durableDraftRevision);
  const draftUpdatedAt = useRef(durableDraftUpdatedAt);
  // Server Actions can overlap at the React/RSC boundary even though the
  // autosave transport serializes their database writes: the next action may
  // have started by the time an earlier RSC acknowledgement arrives. Track
  // every in-flight base revision, rather than one mutable slot, so an older
  // completion cannot clear the newer action's hydration guard.
  const pendingActionExpectedRevisions = useRef(new Set<number>());
  // The RSC payload for a local action can arrive after the action promise has
  // settled. Remember the local edit version that initiated each revision so a
  // delayed acknowledgement cannot replace a newer RHF edit. This only applies
  // to this mounted builder; a provider-return route still hydrates directly
  // from its server-rendered draft.
  const localActionMutationVersions = useRef(new Map<number, number>());
  const focusOrigin = useRef<ProviderField>(initialDraft?.focusOrigin ?? "github");
  const draftOutbox = useMemo(
    () =>
      createBuilderDraftOutbox<BuilderDraft>({
        key: `active:${initialActiveDraftId}`,
      }),
    [initialActiveDraftId],
  );
  type ServerSaveState =
    | {
        mutationId: string;
        saved: { draftId: string; revision: number; updatedAt: string };
      }
    | { mutationId: string; error: string }
    | undefined;
  const [serverSaveState, dispatchServerSave] = useActionState(
    async (
      _previous: ServerSaveState,
      input: SaveActiveBuilderDraftInput,
    ): Promise<ServerSaveState> => {
      if (!saveActiveBuilderDraftAction)
        return {
          mutationId: input.clientMutationId,
          error: "builder-draft-action-unavailable",
        };
      try {
        return {
          mutationId: input.clientMutationId,
          saved: await saveActiveBuilderDraftAction(input),
        };
      } catch (error) {
        return {
          mutationId: input.clientMutationId,
          error: error instanceof Error ? error.message : "builder-draft-save-failed",
        };
      }
    },
    undefined,
  );
  const serverSaveWaiters = useRef(
    new Map<
      string,
      {
        resolve: (saved: {
          draftId: string;
          revision: number;
          updatedAt: string;
        }) => void;
        reject: (error: Error) => void;
      }
    >(),
  );
  useEffect(() => {
    if (!serverSaveState) return;
    const waiter = serverSaveWaiters.current.get(serverSaveState.mutationId);
    if (!waiter) return;
    serverSaveWaiters.current.delete(serverSaveState.mutationId);
    if ("saved" in serverSaveState) waiter.resolve(serverSaveState.saved);
    else waiter.reject(new Error(serverSaveState.error));
  }, [serverSaveState]);
  useEffect(
    () => () => {
      for (const waiter of serverSaveWaiters.current.values())
        waiter.reject(new Error("builder-draft-unmounted"));
      serverSaveWaiters.current.clear();
    },
    [],
  );
  const requestServerSave = useCallback(
    (input: SaveActiveBuilderDraftInput) => {
      const acknowledgement = Promise.withResolvers<{
        draftId: string;
        revision: number;
        updatedAt: string;
      }>();
      serverSaveWaiters.current.set(input.clientMutationId, acknowledgement);
      // `useActionState` gives React ownership of dispatch and result state.
      // This transition launches the action; the returned promise only waits
      // for the matching state acknowledgement so the autosave outbox can
      // clear exactly the mutation the server completed.
      startTransition(() => dispatchServerSave(input));
      return acknowledgement.promise;
    },
    [dispatchServerSave],
  );
  const saveDraft = useCallback(
    async ({
      mutationId,
      snapshot,
      keepalive,
    }: {
      mutationId: string;
      snapshot: BuilderDraft;
      keepalive: boolean;
    }) => {
      const input = {
        version: 1 as const,
        draftId: activeDraftId.current,
        expectedRevision: draftRevision.current,
        clientMutationId: mutationId,
        record: {
          version: 1 as const,
          draft: snapshot,
        } satisfies BuilderDraftRecord,
      };
      if (!keepalive) {
        pendingActionExpectedRevisions.current.add(input.expectedRevision);
        localActionMutationVersions.current.set(
          input.expectedRevision + 1,
          localFormMutationVersion.current,
        );
      }
      try {
        const saved = keepalive
          ? await fetch("/api/builder/draft", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input),
              keepalive: true,
            }).then(async (response) => {
              if (!response.ok) throw new Error("builder-draft-save-failed");
              return (await response.json()) as {
                draftId: string;
                revision: number;
                updatedAt: string;
              };
            })
          : saveActiveBuilderDraftAction
            ? await requestServerSave(input)
            : await Promise.reject(new Error("builder-draft-action-unavailable"));
        activeDraftId.current = saved.draftId;
        draftRevision.current = saved.revision;
        draftUpdatedAt.current = saved.updatedAt;
        return {
          mutationId,
          revision: saved.revision,
          savedAt: saved.updatedAt,
        };
      } finally {
        if (!keepalive) pendingActionExpectedRevisions.current.delete(input.expectedRevision);
      }
    },
    [requestServerSave, saveActiveBuilderDraftAction],
  );
  const autosave = useBuilderDraftAutosave({
    outbox: draftOutbox,
    save: saveDraft,
    debounceMs: 500,
    initialRevision: durableDraftRevision ?? 0,
  });
  const {
    discardPending: discardPendingDraft,
    discardSupersededByRemoteRevision,
    restorePending,
    resumePending,
    schedule: scheduleAutosave,
  } = autosave;
  const [draftSaveError, setDraftSaveError] = useState("");
  const [draftSyncNotice, setDraftSyncNotice] = useState("");
  // Do not infer a user edit from React's post-hydration renders. Apart from
  // creating needless writes, an initial default-draft save can outlive a
  // closing tab and race a later authenticated visit. Track the last snapshot
  // we intentionally queued instead; every actual field or local-control
  // change produces a distinct snapshot.
  const autosaveSnapshotFingerprint = useRef<string | undefined>(
    initialDraft ? JSON.stringify(initialDraft) : undefined,
  );
  const visibleProviderNotices = providerNotices.filter(
    (notice) =>
      !(
        notice.status === "failed" &&
        (notice.reason === "configuration-unavailable" || notice.provider === "github")
      ),
  );
  const draftSnapshot = useCallback(
    (origin = focusOrigin.current): BuilderDraft => {
      // React Hook Form is the live form authority. `useWatch` deliberately
      // renders later, and the convenience mirror can be stale while React
      // processes an input event. Read RHF synchronously at every durable
      // boundary so autosave, provider redirects, and handoff creation all
      // checkpoint exactly the values the user just entered.
      const currentForm = builderForm.getValues();
      formSnapshot.current = currentForm;
      return {
        version: 1,
        form: currentForm,
        team,
        gitScope,
        model,
        zdrOnly,
        showMoreConnections,
        search,
        connectedConnections,
        storageProvider,
        deploymentProvider,
        focusOrigin: origin,
        appNameEditedByUser: appNameEditedByUser.current,
        repositoryEditedByUser: repositoryEditedByUser.current,
      };
    },
    [
      connectedConnections,
      builderForm,
      deploymentProvider,
      gitScope,
      model,
      search,
      showMoreConnections,
      storageProvider,
      team,
      zdrOnly,
    ],
  );
  const applyAuthoritativeDraft = useCallback(
    async (
      remote: {
        draftId: string;
        revision: number;
        updatedAt: string;
        record: BuilderDraftRecord;
      },
      expectedLocalMutationVersion?: number,
    ) => {
      // A polling request can begin before a user edit and return a server
      // snapshot that predates that edit. It is not an incoming concurrent
      // draft and must never reset the newer RHF state.
      if (
        expectedLocalMutationVersion !== undefined &&
        localFormMutationVersion.current !== expectedLocalMutationVersion
      )
        return;
      if (remote.revision <= draftRevision.current) return;
      await discardSupersededByRemoteRevision(remote.revision);
      // A newer server snapshot or save acknowledgement can settle while
      // device outbox I/O is pending. Never move the applied revision backward.
      if (remote.revision <= draftRevision.current) return;
      if (
        expectedLocalMutationVersion !== undefined &&
        localFormMutationVersion.current !== expectedLocalMutationVersion
      )
        return;
      draftRevision.current = remote.revision;
      draftUpdatedAt.current = remote.updatedAt;
      activeDraftId.current = remote.draftId;
      const snapshot = remote.record.draft;
      formSnapshot.current = snapshot.form;
      builderForm.reset(snapshot.form);
      setTeam(snapshot.team);
      setGitScope(snapshot.gitScope);
      setModel(snapshot.model);
      setZdrOnly(snapshot.zdrOnly);
      setShowMoreConnections(snapshot.showMoreConnections);
      setSearch(snapshot.search);
      setConnectedConnections(snapshot.connectedConnections);
      setStorageProvider(snapshot.storageProvider ?? null);
      setDeploymentProvider(snapshot.deploymentProvider ?? null);
      focusOrigin.current = snapshot.focusOrigin;
      appNameEditedByUser.current = snapshot.appNameEditedByUser;
      generatedAppName.current = snapshot.appNameEditedByUser ? undefined : snapshot.form.appName;
      repositoryEditedByUser.current = snapshot.repositoryEditedByUser;
      autosaveSnapshotFingerprint.current = JSON.stringify(snapshot);
      setDraftSyncNotice("Updated from another device");
    },
    [
      builderForm,
      discardSupersededByRemoteRevision,
      setConnectedConnections,
      setDeploymentProvider,
      setDraftSyncNotice,
      setGitScope,
      setModel,
      setSearch,
      setShowMoreConnections,
      setStorageProvider,
      setTeam,
      setZdrOnly,
    ],
  );
  const modelOptions = zdrOnly
    ? allModelOptions.filter((option) =>
        integrations.models.entries.some(
          (modelEntry) => modelEntry.id === option.value && modelEntry.zdr === "all",
        ),
      )
    : allModelOptions;
  let validAppId = false;
  try {
    deriveBuilderAppId(form.appName);
    validAppId = true;
  } catch {}
  const canSubmit = Boolean(
    form.brief.trim() &&
    (!form.appName.trim() || validAppId) &&
    (form.buildDestination !== "web" || (integrations.models.status === "ready" && model)),
  );
  const submitGuidance =
    form.appName.trim() && !validAppId
      ? "Use an app name that can form a lowercase, URL-safe app ID."
      : !form.brief.trim()
        ? "Add an app brief to continue."
        : form.buildDestination === "web" && (integrations.models.status !== "ready" || !model)
          ? "Choose an available model to continue."
          : undefined;
  const updateBrief = (brief: string) => {
    setForm((current) => {
      // `formSnapshot` is updated atomically by every builder field handler.
      // Do not read RHF's per-field store here: while an RSC acknowledgement
      // is hydrating it can briefly combine the latest name with the incoming
      // brief. That transient composite must never become a durable generated
      // name on an OAuth-return checkpoint.
      const currentAppName = current.appName;
      // Preserve a name that RHF knows was entered directly, even if an older
      // Server Action/RSC acknowledgement has not yet caught up with the
      // persisted ownership marker. A newer authoritative remote revision
      // updates generatedAppName above and is still allowed to replace it.
      if (
        appNameEditedByUser.current ||
        (generatedAppName.current !== undefined && generatedAppName.current !== currentAppName)
      )
        return { ...current, appName: currentAppName, brief };
      const appName = appNameFromBrief(brief) || randomAppName(generatedNameSeed);
      generatedAppName.current = appName;
      return {
        ...current,
        brief,
        appName,
        repository: repositoryEditedByUser.current
          ? current.repository
          : repositoryNameFromAppName(appName),
      };
    });
  };
  const addConnection = (name: string) => {
    if (comingSoonConnections.has(name)) return;
    setForm((current) => ({
      ...current,
      connections: current.connections.includes(name)
        ? current.connections
        : [...current.connections, name],
    }));
  };
  const removeConnection = (name: string) => {
    setForm((current) => ({
      ...current,
      connections: current.connections.filter((item) => item !== name),
    }));
    setConnectedConnections((current) => current.filter((item) => item !== name));
  };
  const completeConnection = () => {
    if (!connectionFlow) return;
    setConnectedConnections((current) =>
      current.includes(connectionFlow.name) ? current : [...current, connectionFlow.name],
    );
    setConnectionFlow(null);
  };
  useEffect(() => {
    if (!interactive) return;
    const id = resumedVercelConnection
      ? "vercel-team"
      : resumedGitHubConnection
        ? "git-scope"
        : initialDraft?.focusOrigin === "vercel"
          ? "vercel-team"
          : initialDraft
            ? "git-scope"
            : undefined;
    if (!id) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(id)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialDraft, interactive, resumedGitHubConnection, resumedVercelConnection]);
  useEffect(() => {
    let disposed = false;
    const recoveryStartVersion = localFormMutationVersion.current;
    void restorePending()
      .then((entry) => {
        if (disposed || !entry) return;
        // IndexedDB can resolve after the user has already started editing the
        // hydrated form. Never let that older recovery snapshot replace those
        // edits or reset the user-edited field markers. The new local snapshot
        // will be queued by the normal autosave effect.
        if (localFormMutationVersion.current !== recoveryStartVersion) {
          void discardPendingDraft();
          return;
        }
        // A recovery outbox is only useful when it is newer than the server
        // snapshot rendered for this visit. Server revisions remain canonical.
        if (draftUpdatedAt.current && entry.createdAt <= Date.parse(draftUpdatedAt.current)) {
          void discardPendingDraft();
          return;
        }
        const { snapshot } = entry;
        formSnapshot.current = snapshot.form;
        builderForm.reset(snapshot.form);
        setTeam(snapshot.team);
        setGitScope(snapshot.gitScope);
        setModel(snapshot.model);
        setZdrOnly(snapshot.zdrOnly);
        setShowMoreConnections(snapshot.showMoreConnections);
        setSearch(snapshot.search);
        setConnectedConnections(snapshot.connectedConnections);
        setStorageProvider(snapshot.storageProvider ?? null);
        setDeploymentProvider(snapshot.deploymentProvider ?? null);
        focusOrigin.current = snapshot.focusOrigin;
        appNameEditedByUser.current = snapshot.appNameEditedByUser;
        generatedAppName.current = snapshot.appNameEditedByUser ? undefined : snapshot.form.appName;
        repositoryEditedByUser.current = snapshot.repositoryEditedByUser;
        autosaveSnapshotFingerprint.current = JSON.stringify(snapshot);
        if (!disposed) void resumePending();
      })
      .finally(() => {
        if (!disposed) setDraftRecoveryComplete(true);
      });
    return () => {
      disposed = true;
    };
  }, [builderForm, discardPendingDraft, restorePending, resumePending]);
  useEffect(() => {
    let disposed = false;
    let wasHidden = document.visibilityState === "hidden";
    const checkForServerDraft = async () => {
      if (document.visibilityState === "hidden" || !navigator.onLine) return;
      const localMutationVersion = localFormMutationVersion.current;
      // A completed foreground action can become visible to this read before
      // its acknowledgement advances draftRevision. Do not reinterpret that
      // device-local save as a remote revision and replace edits made while
      // the action was in flight.
      if (pendingActionExpectedRevisions.current.size > 0) return;
      try {
        if (!loadActiveBuilderDraftAction) return;
        const remote = await loadActiveBuilderDraftAction();
        if (
          disposed ||
          !remote ||
          pendingActionExpectedRevisions.current.size > 0 ||
          localFormMutationVersion.current !== localMutationVersion
        )
          return;
        await applyAuthoritativeDraft(remote, localMutationVersion);
      } catch {
        // Autosave owns retry/error presentation; sync polling stays quiet.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "hidden") {
        wasHidden = true;
        return;
      }
      // Browsers can emit an initial visible event while the builder hydrates.
      // The server-rendered snapshot is already authoritative for that first
      // paint; only refresh after this document has actually been backgrounded.
      if (wasHidden) void checkForServerDraft();
    };
    const timer = setInterval(() => void checkForServerDraft(), 10_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [applyAuthoritativeDraft, loadActiveBuilderDraftAction]);
  useEffect(() => {
    if (durableDraftRevision <= draftRevision.current) return;
    if (!initialDraft || !durableDraftId || !durableDraftUpdatedAt) return;
    const actionMutationVersion = localActionMutationVersions.current.get(durableDraftRevision);
    if (pendingActionExpectedRevisions.current.has(durableDraftRevision - 1)) {
      activeDraftId.current = durableDraftId;
      draftRevision.current = durableDraftRevision;
      draftUpdatedAt.current = durableDraftUpdatedAt;
      return;
    }
    if (
      actionMutationVersion !== undefined &&
      localFormMutationVersion.current !== actionMutationVersion
    ) {
      activeDraftId.current = durableDraftId;
      draftRevision.current = durableDraftRevision;
      draftUpdatedAt.current = durableDraftUpdatedAt;
      localActionMutationVersions.current.delete(durableDraftRevision);
      return;
    }
    if (actionMutationVersion !== undefined)
      localActionMutationVersions.current.delete(durableDraftRevision);
    void applyAuthoritativeDraft({
      draftId: durableDraftId,
      revision: durableDraftRevision,
      updatedAt: durableDraftUpdatedAt,
      record: { version: 1, draft: initialDraft },
    });
  }, [
    applyAuthoritativeDraft,
    durableDraftId,
    durableDraftRevision,
    durableDraftUpdatedAt,
    initialDraft,
  ]);
  useEffect(() => {
    if (!draftSyncNotice) return;
    const timer = window.setTimeout(() => setDraftSyncNotice(""), 4_000);
    return () => window.clearTimeout(timer);
  }, [draftSyncNotice]);
  useEffect(() => {
    const snapshot = draftSnapshot();
    const fingerprint = JSON.stringify(snapshot);
    if (autosaveSnapshotFingerprint.current === undefined) {
      // Establish the hydrated server/form state as the baseline. The first
      // deliberate edit (including a non-RHF builder control) will differ.
      autosaveSnapshotFingerprint.current = fingerprint;
      return;
    }
    if (autosaveSnapshotFingerprint.current === fingerprint) return;
    autosaveSnapshotFingerprint.current = fingerprint;
    scheduleAutosave(snapshot);
  }, [draftSnapshot, form, scheduleAutosave]);
  const beginProviderConnection = async (provider: ProviderField) => {
    focusOrigin.current = provider;
    const draft = draftSnapshot(provider);
    autosave.schedule(draft);
    await autosave.flush();
    if (await autosave.restorePending()) {
      setDraftSaveError("We couldn’t save your form. Retry saving to connect a provider.");
      return;
    }
    setDraftSaveError("");
    // The flush includes edits queued while the checkpoint was in flight.
    // Return hydration reads that server draft; never stamp the earlier click
    // snapshot with the final revision and restore it over the newer save.
    // The service owns the one active draft and may acknowledge a canonical
    // ID different from the optimistic local ID. Capture it only after the
    // Server Action checkpoint has completed so a provider return can never
    // target a stale, non-authoritative draft.
    router.push(`/${provider}/installations?returnTo=%2F&resume=${activeDraftId.current}`);
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (canSubmit && (await builderForm.trigger())) {
      // `useWatch` intentionally updates on React's render cadence. A click
      // immediately after the final input event can therefore observe the
      // prior rendered value here. Read RHF synchronously at this action
      // boundary so the durable handoff cannot be created from a stale
      // generated name (or any other last-keystroke value).
      const currentForm = builderForm.getValues();
      formSnapshot.current = currentForm;
      autosave.schedule(draftSnapshot());
      await autosave.flush();
      if (await autosave.restorePending()) {
        setDraftSaveError("We couldn’t save your form. Retry saving before creating your app.");
        return;
      }
      setDraftSaveError("");
      const appName =
        currentForm.appName.trim() || appNameFromBrief(currentForm.brief) || randomAppName();
      onCreate(
        {
          ...currentForm,
          appName,
          repository: currentForm.repository.trim() || repositoryNameFromAppName(appName),
          ...(deploymentProvider === "vercel" && team ? { vercelInstallationId: team } : {}),
          ...(storageProvider === "github" && gitScope ? { githubInstallationId: gitScope } : {}),
          modelId: preferredModelId,
        },
        activeDraftId.current,
      );
    }
  }

  return (
    <main className={styles.authenticatedPage} id="main-content">
      <form className={styles.builderCard} onSubmit={submit}>
        <p className={styles.draftStatus} role="status" aria-live="polite">
          {draftSaveError
            ? draftSaveError
            : draftSyncNotice
              ? draftSyncNotice
              : autosave.status === "saving"
                ? "Saving your draft…"
                : autosave.status === "saved"
                  ? "Draft saved"
                  : autosave.status === "offline"
                    ? "Offline — your draft will retry when you’re back online."
                    : autosave.status === "error"
                      ? "Your latest edit is safe on this device and will retry."
                      : "Your draft saves automatically."}
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
        <fieldset
          className={styles.builderControls}
          disabled={!interactive}
          aria-busy={!interactive}
        >
          <div className={styles.cardTitle}>
            <div>
              <h1>Build an app</h1>
              <p>
                Describe what you want to build, then choose how it should be created and delivered.
              </p>
            </div>
          </div>
          <ProviderNotices notices={visibleProviderNotices} />
          <AppDetailsSection
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
              const currentIndex = briefExamples.indexOf(
                form.brief as (typeof briefExamples)[number],
              );
              const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % briefExamples.length;
              updateBrief(briefExamples[nextIndex]);
            }}
          />
          <BuildWithSection
            comingSoonEnabled={comingSoonEnabled}
            selected={form.buildDestination}
            onChange={(buildDestination) => {
              setForm((current) => ({ ...current, buildDestination }));
            }}
          >
            {form.buildDestination === "web" ? (
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
                    !integrations.models.entries.some(
                      (entry) => entry.id === model && entry.zdr === "all",
                    )
                  )
                    setModel("");
                }}
                onRetry={() => router.refresh()}
              />
            ) : null}
          </BuildWithSection>
          <StoreInSection
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
          <DeployToSection
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
          {connectionsEnabled ? (
            <ConnectionsSection
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
          ) : null}
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
        </fieldset>
      </form>
      {connectionFlow ? (
        <ConnectionDrawer
          flow={connectionFlow}
          onClose={() => setConnectionFlow(null)}
          onStageChange={(stage) =>
            setConnectionFlow((current) => (current ? { ...current, stage } : current))
          }
          onConnected={completeConnection}
        />
      ) : null}
    </main>
  );
}
