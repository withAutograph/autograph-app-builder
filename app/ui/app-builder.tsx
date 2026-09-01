"use client";

import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  DollarSign,
  ExternalLink,
  Globe,
  Info,
  Monitor,
  Plus,
  PlusCircle,
  RefreshCw,
  Search,
  X,
} from "@geist-ui/icons";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { FaGithub, FaLock, FaLockOpen } from "react-icons/fa";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  SiBitbucket,
  SiCloudflare,
  SiGitlab,
  SiNetlify,
  SiOpenai,
  SiQuickbooks,
  SiSage,
  SiVercel,
  SiXero,
} from "react-icons/si";

import type { BuilderIntegrationState } from "@/lib/integrations/builder-state";
import type { BuilderProvisionResponse } from "../../lib/provisioning/contracts";
import { deriveBuilderAppId } from "../../lib/provisioning/names";
import { SectionShell } from "../../components/create-app/choice-card";
import { ProviderChoiceSection } from "../../components/create-app/provider-choice-section";
import styles from "./app-builder.module.css";
import autographIcon from "../../assets/autograph-icon.png";
import type { ProviderConnectionNotice } from "../../lib/integrations/provider-connection-status";
import { githubStoreInViewModel } from "../../lib/integrations/store-in-view-model";
import {
  activeProvisioningStorageKey,
  clearActiveProvisioning,
  clearBuilderDraft,
  parseActiveProvisioning,
  persistActiveProvisioning,
  persistBuilderDraft,
  readBuilderDraft,
} from "./builder-session";
import { Header, ProviderNotices } from "./builder-shell";
import { BuilderNextSteps } from "./builder-next-steps";
import { BuilderProvisionedResources } from "./builder-provisioned-resources";
import { BuilderInstallInstructions } from "./builder-install-instructions";
import { BuilderHandoffProgress } from "./builder-handoff-progress";
import type {
  BuilderDraft,
  BuilderForm,
  BuilderHandoffReference,
  BuildDestination,
  ClipboardState,
  DeploymentProvider,
  HandoffAttempt,
  ProviderField,
  StorageProvider,
} from "./builder-types";
export type {
  BuilderDraft,
  BuilderForm,
  BuilderHandoffReference,
  BuildDestination,
  ClipboardState,
  DeploymentProvider,
  HandoffAttempt,
  ProviderField,
  StorageProvider,
} from "./builder-types";

type Screen = "builder" | "handoff" | "ready";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export type ConnectionStage = "connect" | "configure" | "customize";
export type ConnectionFlow = { name: string; stage: ConnectionStage };

function CursorMark() {
  return (
    <svg
      width="16"
      height="18"
      viewBox="0 0 466.73 532.09"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"
      />
    </svg>
  );
}

const maximumHandoffUrlLength = 8_000;

function buildDestinationLabel(destination: BuildDestination) {
  if (destination === "web") return "Web Chat";
  return destination === "codex" ? "ChatGPT / Codex" : "Cursor";
}

function providerSetupMessage(
  provider: "GitHub" | "Vercel",
  result:
    BuilderProvisionResponse["github"] | BuilderProvisionResponse["vercel"],
) {
  if (result.status === "succeeded" || result.code === "not_selected") return;
  const reason = {
    configuration_unavailable: "provider configuration is not active",
    credential_unavailable: "the selected credential needs to be reconnected",
    installation_inactive: "the selected installation is no longer active",
    name_conflict: "all safe name candidates were already in use",
    provider_rejected:
      "the provider rejected the requested setup or Git access",
    provider_unavailable: "the provider could not be reached",
    source_unavailable: "the immutable starter artifact could not be loaded",
    source_mismatch: "the immutable starter artifact failed verification",
    postcondition_failed:
      "provider read-back did not match the requested setup",
    github_required:
      "GitHub setup must succeed before a linked Vercel project can be created",
    feature_disabled:
      "resource provisioning is not active for this environment",
  }[result.code];
  return `${provider}: ${reason}.`;
}

export function buildAppHandoffPrompt(handoffId: string) {
  if (!uuidPattern.test(handoffId)) throw new Error("handoff-id-invalid");
  return `Use the Autograph App Builder plugin to create this app.

If Autograph App Builder is unavailable, install the official plugin first:

codex plugin marketplace add withAutograph/marketplace --ref main
codex plugin marketplace upgrade autograph
codex plugin add app-builder@autograph

Verify that app-builder@autograph is enabled, then continue the prepared app with this handoff ID:

${handoffId}

Use autograph_start with the handoffId. Do not use another app builder or edit a repository directly. If autograph_start is unavailable, stop and explain how to install the official plugin.`;
}

function buildAppHandoffUrl(destination: BuildDestination, handoffId: string) {
  const prompt = encodeURIComponent(buildAppHandoffPrompt(handoffId));
  return destination === "codex"
    ? `codex://new?prompt=${prompt}`
    : `cursor://anysphere.cursor-deeplink/prompt?text=${prompt}`;
}

function attemptAppHandoff(
  destination: BuildDestination,
  handoffId: string,
): HandoffAttempt {
  const url = buildAppHandoffUrl(destination, handoffId);
  if (url.length > maximumHandoffUrlLength) return "too-long";
  try {
    window.open(url, "_blank", "noopener,noreferrer");
    return "attempted";
  } catch {
    return "blocked";
  }
}

async function createBuilderHandoff(input: {
  form: BuilderForm;
  provisioning: BuilderProvisionResponse;
  creationRequestId: string;
}): Promise<BuilderHandoffReference> {
  const response = await fetch("/api/builder/handoffs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      creationRequestId: input.creationRequestId,
      ...(input.provisioning.requestDigest === "0".repeat(64)
        ? {}
        : { provisioningRequestId: input.provisioning.requestId }),
      appName: input.form.appName,
      repository: {
        name: input.form.repository,
        private: input.form.privateRepository,
      },
      brief: input.form.brief,
      modelId: input.form.modelId,
      connections: input.form.connections,
    }),
  });
  if (!response.ok) throw new Error(`handoff-${response.status}`);
  const value = (await response.json()) as Partial<BuilderHandoffReference>;
  if (
    value.version !== 1 ||
    typeof value.handoffId !== "string" ||
    !uuidPattern.test(value.handoffId) ||
    typeof value.expiresAt !== "string" ||
    Number.isNaN(Date.parse(value.expiresAt))
  )
    throw new Error("handoff-response-invalid");
  return {
    version: 1,
    handoffId: value.handoffId,
    expiresAt: value.expiresAt,
  };
}

const featuredConnections = [
  ["QuickBooks", "quickbooks"],
  ["Ramp", "ramp"],
  ["NetSuite", "netsuite"],
  ["Xero", "xero"],
  ["Sage Intacct", "sage-intacct"],
] as const;

const allConnectionNames = featuredConnections.map(([name]) => name);
const comingSoonConnections = new Set([
  "Ramp",
  "NetSuite",
  "Xero",
  "Sage Intacct",
]);

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
  return (
    connectionDescriptions[name] ?? `Connect ${name} tools and data to your app`
  );
}

const suggestions = [
  "Build a customer feedback portal",
  "Create an internal operations dashboard",
] as const;

const defaultBrief =
  "# Product\n\nBuild a focused app that helps people complete one important workflow. Define the users, the desired outcome, the repository constraints, and the acceptance criteria. Match the requested product tone and interface, verify assumptions before building, and make the final checks explicit.";

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
const preferredModelId = "openai/gpt-5.6-sol";

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
    const adjective =
      randomNameAdjectives[
        Math.floor(Math.random() * randomNameAdjectives.length)
      ];
    const noun =
      randomNameNouns[Math.floor(Math.random() * randomNameNouns.length)];
    return `${adjective} ${noun}`;
  }
  const hash = [...seed].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  const adjective = randomNameAdjectives[hash % randomNameAdjectives.length];
  const noun =
    randomNameNouns[
      Math.floor(hash / randomNameAdjectives.length) % randomNameNouns.length
    ];
  return `${adjective} ${noun}`;
}

export function AutographMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={styles.brand} data-compact={compact || undefined}>
      <Image
        className={styles.brandMark}
        src={autographIcon}
        width={23}
        height={23}
        alt=""
      />
      <span>Autograph</span>
    </span>
  );
}

export function InfoTooltip({ children }: { children: string }) {
  const tooltipId = useId();

  return (
    <span className={styles.infoTooltip}>
      <button type="button" aria-label={children} aria-describedby={tooltipId}>
        <Info size={12} aria-hidden="true" />
      </button>
      <span id={tooltipId} role="tooltip">
        {children}
      </span>
    </span>
  );
}

export function ConnectionIcon({
  kind,
  name,
}: {
  kind?: string;
  name: string;
}) {
  const icons = {
    quickbooks: SiQuickbooks,
    xero: SiXero,
    "sage-intacct": SiSage,
  };
  const Icon = kind ? icons[kind as keyof typeof icons] : undefined;
  const hasBrandAsset = kind === "ramp" || kind === "netsuite";
  return (
    <span
      className={styles.connectionIcon}
      data-kind={kind}
      data-name={name}
      aria-hidden="true"
    >
      {Icon ? <Icon size={18} /> : hasBrandAsset ? null : <Globe size={18} />}
    </span>
  );
}

export type ComboOption = {
  value: string;
  label: string;
  detail?: string;
  icon?: string;
};

type ComboFooter = ComboOption & { disabled?: boolean };

export function SearchCombobox({
  label,
  value,
  options,
  onChange,
  prefix,
  menuFooter,
  optionIcon,
  footerIcon,
  detailPills = false,
  showSelectedCheck = true,
  placeholder = "Select…",
  disabled = false,
  onFooterSelect,
  inputId,
}: {
  label: string;
  value: string;
  options: ComboOption[];
  onChange: (value: string) => void;
  prefix: ReactNode;
  menuFooter?: ComboFooter;
  optionIcon?: (option: ComboOption) => ReactNode;
  footerIcon?: ReactNode;
  detailPills?: boolean;
  showSelectedCheck?: boolean;
  placeholder?: string;
  disabled?: boolean;
  onFooterSelect?: () => void;
  inputId?: string;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const [query, setQuery] = useState(selected?.label ?? "");
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(0);
  const shown = filtering
    ? options.filter((option) =>
        `${option.label} ${option.detail ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
    : options;

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  function closeAndRestore() {
    setOpen(false);
    setQuery(selected?.label ?? "");
    setFiltering(false);
    setActive(0);
  }

  function choose(option: ComboOption) {
    if (option.value.startsWith("create-") || option.value.startsWith("add-"))
      return;
    onChange(option.value);
    setQuery(option.label);
    setFiltering(false);
    setOpen(false);
  }

  return (
    <div
      className={styles.combobox}
      ref={rootRef}
      data-open={open || undefined}
      data-label={label}
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-controls={`${id}-listbox`}
    >
      <div className={styles.comboPrefix} aria-hidden="true">
        {prefix}
      </div>
      <input
        id={inputId}
        role="searchbox"
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={`${id}-listbox`}
        value={query}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onFocus={(event) => {
          setOpen(true);
          setFiltering(false);
          event.currentTarget.select();
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setFiltering(true);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") closeAndRestore();
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((index) =>
              Math.min(index + 1, Math.max(shown.length - 1, 0)),
            );
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          }
          if (event.key === "Enter" && open && shown[active]) {
            event.preventDefault();
            choose(shown[active]);
          }
        }}
      />
      {selected?.detail ? (
        <span className={styles.comboDetail}>{selected.detail}</span>
      ) : null}
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div className={styles.comboMenu} role="dialog" hidden={!open}>
        <div id={`${id}-listbox`} role="listbox">
          {shown.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              data-has-icon={optionIcon ? "" : undefined}
              data-option-value={option.value}
              data-active={index === active || undefined}
              key={option.value}
              onPointerMove={() => setActive(index)}
              onClick={() => choose(option)}
            >
              {optionIcon ? (
                <span className={styles.comboOptionIcon} aria-hidden="true">
                  {optionIcon(option)}
                </span>
              ) : null}
              <span className={styles.comboOptionLabel}>{option.label}</span>
              {option.detail ? (
                <small data-pill={detailPills || undefined}>
                  {option.detail}
                </small>
              ) : null}
              {showSelectedCheck && option.value === value ? (
                <Check size={16} aria-hidden="true" />
              ) : null}
            </button>
          ))}
          {!shown.length ? (
            <p className={styles.noResults}>No results found.</p>
          ) : null}
        </div>
        {menuFooter ? (
          <button
            className={styles.comboFooter}
            type="button"
            disabled={menuFooter.disabled}
            onClick={() => {
              setOpen(false);
              onFooterSelect?.();
            }}
          >
            <span className={styles.comboOptionIcon} aria-hidden="true">
              {footerIcon ?? <Plus size={20} />}
            </span>
            <span className={styles.comboOptionLabel}>{menuFooter.label}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function AppDetailsSection({
  appName,
  brief,
  onAppNameChange,
  onBriefChange,
  onCycleBrief,
}: {
  appName: string;
  brief: string;
  onAppNameChange: (value: string) => void;
  onBriefChange: (value: string) => void;
  onCycleBrief: () => void;
}) {
  return (
    <fieldset
      className={`${styles.sectionField} ${styles.appDetailsSection}`}
      data-create-app-section="app-details"
    >
      <legend className={styles.visuallyHidden}>App details</legend>
      <label htmlFor="app-name">
        <span className={styles.fieldLabel}>
          App Name <small aria-hidden="true">Optional</small>
        </span>
        <input
          id="app-name"
          name="app-name"
          aria-label="App Name"
          autoComplete="off"
          spellCheck={false}
          value={appName}
          onChange={(event) => onAppNameChange(event.target.value)}
          placeholder="support-app"
        />
      </label>
      <label htmlFor="app-brief">
        <span className={styles.fieldLabel}>
          App Brief <small aria-hidden="true">Required</small>
        </span>
        <div className={styles.briefField}>
          <textarea
            id="app-brief"
            name="app-brief"
            aria-label="App Brief"
            autoComplete="off"
            value={brief}
            onChange={(event) => onBriefChange(event.target.value)}
            placeholder="Describe the app you want to build…"
          />
          <button
            type="button"
            aria-label="Try another app brief example"
            onClick={onCycleBrief}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </label>
      <p className={styles.helpText}>
        Define this app’s users, workflow, constraints, and desired outcome.{" "}
        <a
          href="https://github.com/withAutograph/autograph-app-builder"
          target="_blank"
          rel="noreferrer"
        >
          Read the App Builder docs ↗
        </a>
        .
      </p>
    </fieldset>
  );
}

export function BuildWithSection({
  children,
  comingSoonEnabled = false,
  selected,
  onChange,
}: {
  children?: ReactNode;
  comingSoonEnabled?: boolean;
  selected: BuildDestination;
  onChange: (destination: BuildDestination) => void;
}) {
  return (
    <>
      <SectionShell
        className={`${styles.sectionField} ${styles.buildSection}`}
        section="build-with"
        title="Build with"
        description="Where do you want to build this app?"
      >
        <div
          className={`${styles.optionGrid} ${styles.buildDestinationGrid}`}
          role="radiogroup"
          aria-label="Build destination"
        >
          {comingSoonEnabled ? (
            <label className={styles.unavailableOption}>
              <Monitor size={18} aria-hidden="true" />
              <span>
                Web Chat <small>Coming soon</small>
              </span>
              <input
                type="radio"
                name="build-destination"
                value="web"
                disabled
                checked={selected === "web"}
              />
            </label>
          ) : null}
          <label>
            <SiOpenai size={18} aria-hidden="true" />
            ChatGPT / Codex
            <input
              type="radio"
              name="build-destination"
              value="codex"
              required
              checked={selected === "codex"}
              onChange={() => onChange("codex")}
            />
          </label>
          <label>
            <CursorMark />
            Cursor
            <input
              type="radio"
              name="build-destination"
              value="cursor"
              required
              checked={selected === "cursor"}
              onChange={() => onChange("cursor")}
            />
          </label>
        </div>
      </SectionShell>
      {children}
    </>
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
        <InfoTooltip>
          Only use providers that support Zero Data Retention.
        </InfoTooltip>
      </label>
      <SearchCombobox
        label={
          options.find((option) => option.value === model)?.label ??
          "Select model"
        }
        value={model}
        options={options}
        onChange={onModelChange}
        prefix={<Search size={15} />}
        showSelectedCheck={false}
        placeholder={available ? "Select model" : "Models unavailable"}
        disabled={!available}
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
                inputId="vercel-team"
                value={team}
                options={teamOptions}
                onChange={onTeamChange}
                prefix={<span className={styles.teamDot} data-team={team} />}
                menuFooter={{
                  value: "create-team",
                  label: "Connect another Vercel team",
                }}
                onFooterSelect={onConnect}
                optionIcon={(option) => (
                  <span className={styles.teamDot} data-team={option.value} />
                )}
                footerIcon={<PlusCircle size={18} />}
                detailPills
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
            <div
              className={`${styles.repoRow} ${gitScope ? styles.repoRowWithRepository : ""}`}
            >
              <div className={styles.integrationField}>
                <span className={styles.fieldLabel}>
                  Git Scope <small aria-hidden="true">Optional</small>
                </span>
                {connected ? (
                  <SearchCombobox
                    label="Git Scope"
                    inputId="git-scope"
                    value={gitScope}
                    options={gitScopeOptions}
                    onChange={onGitScopeChange}
                    prefix={<FaGithub size={16} />}
                    menuFooter={{
                      value: "add-github",
                      label: githubView.actionLabel,
                    }}
                    onFooterSelect={onConnect}
                    optionIcon={() => <FaGithub size={16} />}
                    footerIcon={<Plus size={21} />}
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
                        onChange={(event) =>
                          onRepositoryChange(event.target.value)
                        }
                        placeholder="my-app"
                      />
                      <label
                        className={styles.privacyToggle}
                        aria-label="Private repository"
                      >
                        <input
                          type="checkbox"
                          checked={privateRepository}
                          onChange={(event) =>
                            onPrivacyChange(event.target.checked)
                          }
                        />
                        <span>
                          <i>
                            {privateRepository ? (
                              <FaLock size={11} />
                            ) : (
                              <FaLockOpen size={12} />
                            )}
                          </i>
                        </span>
                        <em role="tooltip">
                          This repository will be{" "}
                          {privateRepository ? "private" : "public"}.
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
    showMore || normalizedSearch
      ? allConnectionNames
      : allConnectionNames.slice(0, 2)
  ).filter(
    (name) =>
      !normalizedSearch || name.toLowerCase().includes(normalizedSearch),
  );
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
                {comingSoon ? (
                  <span className={styles.comingSoon}>Coming soon</span>
                ) : null}
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
              <button
                type="button"
                aria-label={`Remove ${name}`}
                onClick={() => onRemove(name)}
              >
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
  const [description, setDescription] = useState(
    connectionDescription(flow.name),
  );
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
          <ConnectionIcon
            kind={connectionKind.get(flow.name)}
            name={flow.name}
          />
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
                  <ConnectionIcon
                    kind={connectionKind.get(flow.name)}
                    name={flow.name}
                  />
                </span>
                <span>
                  <Image src={autographIcon} width={28} height={28} alt="" />
                </span>
              </div>
              <h4>Connect your {flow.name} account</h4>
              <p>Authorize Autograph to access {flow.name} on your behalf.</p>
              <button type="button" onClick={() => setShowSuccess(true)}>
                Connect {flow.name}{" "}
                <ExternalLink size={14} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className={styles.configureFields}>
              <label>
                {accountLabel}
                <button type="button" className={styles.accountSelect}>
                  <ConnectionIcon
                    kind={connectionKind.get(flow.name)}
                    name={flow.name}
                  />
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
                  <small>
                    Prefer this connection when {flow.name} is used.
                  </small>
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
          This connection is prepared locally. External authorization and
          credentials are not stored by this prototype.
        </p>
      </div>
    </div>
  );
}

export function AnonymousBuilder({
  onContinue,
}: {
  onContinue: (brief: string) => void;
}) {
  const [brief, setBrief] = useState("");
  return (
    <main className={styles.anonymousPage} id="main-content">
      <a className={styles.skipLink} href="#anonymous-brief">
        Skip to content
      </a>
      <header className={styles.publicHeader}>
        <AutographMark />
        <span>New App</span>
        <div>
          <a href="/auth/sign-in?callbackURL=%2F">Sign In</a>
          <a className={styles.darkButton} href="/auth/sign-up?callbackURL=%2F">
            Sign Up
          </a>
        </div>
      </header>
      <section className={styles.promptCard}>
        <div className={styles.cardTitle}>
          <h1>Build an app</h1>
          <AutographMark compact />
        </div>
        <label htmlFor="anonymous-brief">What should this app do?</label>
        <div className={styles.promptField}>
          <textarea
            id="anonymous-brief"
            name="app-brief"
            autoComplete="off"
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="Help me create a customer portal, build an internal dashboard, or launch a new workflow…"
          />
          <button
            type="button"
            disabled={!brief.trim()}
            onClick={() => onContinue(brief)}
          >
            Continue
          </button>
        </div>
        <div className={styles.suggestions}>
          <span>Suggestions</span>
          {suggestions.map((suggestion) => (
            <button
              type="button"
              key={suggestion}
              onClick={() => setBrief(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
        <p>
          You’ll create or sign in to your Autograph account before building.
        </p>
      </section>
    </main>
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
  const allModelOptions = integrations.models.entries.map((model) => ({
    value: model.id,
    label: model.name,
    detail: model.id,
  }));
  const defaultModel = integrations.models.entries.some(
    (entry) => entry.id === preferredModelId,
  )
    ? preferredModelId
    : (integrations.models.defaultModelId ?? allModelOptions[0]?.value ?? "");
  const effectiveInitialBrief = initialBrief.trim()
    ? initialBrief
    : defaultBrief;
  const initialAppName =
    appNameFromBrief(effectiveInitialBrief) || randomAppName(generatedNameSeed);
  const [form, setForm] = useState<BuilderForm>(
    initialDraft
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
        },
  );
  const appNameEditedByUser = useRef(
    initialDraft?.appNameEditedByUser ?? false,
  );
  const repositoryEditedByUser = useRef(
    initialDraft?.repositoryEditedByUser ?? false,
  );
  const hasUnsavedChanges = useRef(false);
  const suppressUnsavedWarning = useRef(false);
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
  const [model, setModel] = useState(initialDraft?.model ?? defaultModel);
  const [zdrOnly, setZdrOnly] = useState(initialDraft?.zdrOnly ?? false);
  const [showMoreConnections, setShowMoreConnections] = useState(
    initialDraft?.showMoreConnections ?? false,
  );
  const [search, setSearch] = useState(initialDraft?.search ?? "");
  const [connectionFlow, setConnectionFlow] = useState<ConnectionFlow | null>(
    null,
  );
  const [connectedConnections, setConnectedConnections] = useState<string[]>(
    initialDraft?.connectedConnections ?? [],
  );
  const [storageProvider, setStorageProvider] =
    useState<StorageProvider | null>(
      initialDraft?.storageProvider === null ? null : "github",
    );
  const [deploymentProvider, setDeploymentProvider] =
    useState<DeploymentProvider | null>(
      initialDraft?.deploymentProvider === "vercel" ? "vercel" : null,
    );
  const visibleProviderNotices = providerNotices.filter(
    (notice) =>
      !(
        notice.status === "failed" &&
        (notice.reason === "configuration-unavailable" ||
          notice.provider === "github")
      ),
  );
  const modelOptions = zdrOnly
    ? allModelOptions.filter((option) =>
        integrations.models.entries.some(
          (modelEntry) =>
            modelEntry.id === option.value && modelEntry.zdr === "all",
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
    (form.buildDestination !== "web" ||
      (integrations.models.status === "ready" && model)),
  );
  const submitGuidance =
    form.appName.trim() && !validAppId
      ? "Use an app name that can form a lowercase, URL-safe app ID."
      : !form.brief.trim()
        ? "Add an app brief to continue."
        : form.buildDestination === "web" &&
            (integrations.models.status !== "ready" || !model)
          ? "Choose an available model to continue."
          : undefined;
  const updateBrief = (brief: string) => {
    if (brief !== form.brief) hasUnsavedChanges.current = true;
    setForm((current) => {
      if (appNameEditedByUser.current) return { ...current, brief };
      const appName =
        appNameFromBrief(brief) || randomAppName(generatedNameSeed);
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
    hasUnsavedChanges.current = true;
    setForm((current) => ({
      ...current,
      connections: current.connections.includes(name)
        ? current.connections
        : [...current.connections, name],
    }));
  };
  const removeConnection = (name: string) => {
    hasUnsavedChanges.current = true;
    setForm((current) => ({
      ...current,
      connections: current.connections.filter((item) => item !== name),
    }));
    setConnectedConnections((current) =>
      current.filter((item) => item !== name),
    );
  };
  const completeConnection = () => {
    if (!connectionFlow) return;
    setConnectedConnections((current) =>
      current.includes(connectionFlow.name)
        ? current
        : [...current, connectionFlow.name],
    );
    setConnectionFlow(null);
  };
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (hasUnsavedChanges.current && !suppressUnsavedWarning.current)
        event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => {
    if (!initialDraft) return;
    const id =
      initialDraft.focusOrigin === "vercel" ? "vercel-team" : "git-scope";
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(id)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialDraft]);
  const beginProviderConnection = (provider: ProviderField) => {
    const key = crypto.randomUUID();
    const draft: BuilderDraft = {
      version: 1,
      form,
      team,
      gitScope,
      model,
      zdrOnly,
      showMoreConnections,
      search,
      connectedConnections,
      storageProvider,
      deploymentProvider,
      focusOrigin: provider,
      appNameEditedByUser: appNameEditedByUser.current,
      repositoryEditedByUser: repositoryEditedByUser.current,
    };
    persistBuilderDraft(key, draft);
    suppressUnsavedWarning.current = true;
    router.push(`/${provider}/installations?returnTo=%2F&resume=${key}`);
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSubmit) {
      const appName =
        form.appName.trim() || appNameFromBrief(form.brief) || randomAppName();
      onCreate(
        {
          ...form,
          appName,
          repository:
            form.repository.trim() || repositoryNameFromAppName(appName),
          ...(deploymentProvider === "vercel" && team
            ? { vercelInstallationId: team }
            : {}),
          ...(storageProvider === "github" && gitScope
            ? { githubInstallationId: gitScope }
            : {}),
          modelId: model,
        },
        resumeKey,
      );
    }
  }

  return (
    <main className={styles.authenticatedPage} id="main-content">
      <form className={styles.builderCard} onSubmit={submit}>
        <div className={styles.cardTitle}>
          <div>
            <h1>Build an app</h1>
            <p>
              Describe what you want to build, then choose how it should be
              created and delivered.
            </p>
          </div>
        </div>
        <ProviderNotices notices={visibleProviderNotices} />
        <AppDetailsSection
          appName={form.appName}
          brief={form.brief}
          onAppNameChange={(appName) => {
            appNameEditedByUser.current = true;
            if (appName !== form.appName) hasUnsavedChanges.current = true;
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
            const nextIndex =
              currentIndex < 0 ? 0 : (currentIndex + 1) % briefExamples.length;
            updateBrief(briefExamples[nextIndex]);
          }}
        />
        <BuildWithSection
          comingSoonEnabled={comingSoonEnabled}
          selected={form.buildDestination}
          onChange={(buildDestination) => {
            if (buildDestination !== form.buildDestination)
              hasUnsavedChanges.current = true;
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
                if (value !== model) hasUnsavedChanges.current = true;
                setModel(value);
              }}
              onZdrChange={(checked) => {
                if (checked !== zdrOnly) hasUnsavedChanges.current = true;
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
            hasUnsavedChanges.current = true;
            setStorageProvider((current) =>
              current === provider ? null : provider,
            );
          }}
          onGitScopeChange={(value) => {
            if (value !== gitScope) hasUnsavedChanges.current = true;
            setGitScope(value);
          }}
          onRepositoryChange={(repository) => {
            repositoryEditedByUser.current = true;
            if (repository !== form.repository)
              hasUnsavedChanges.current = true;
            setForm((current) => ({ ...current, repository }));
          }}
          onPrivacyChange={(privateRepository) => {
            if (privateRepository !== form.privateRepository)
              hasUnsavedChanges.current = true;
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
            hasUnsavedChanges.current = true;
            setDeploymentProvider((current) =>
              current === provider ? null : provider,
            );
          }}
          onTeamChange={(value) => {
            if (value !== team) hasUnsavedChanges.current = true;
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
                stage: connectedConnections.includes(name)
                  ? "configure"
                  : "connect",
              })
            }
          />
        ) : null}
        <div className={styles.submitArea}>
          <button
            className={styles.createButton}
            type="submit"
            disabled={!canSubmit}
            aria-describedby={
              submitGuidance ? "create-app-guidance" : undefined
            }
          >
            Create App
          </button>
          {submitGuidance ? (
            <p className={styles.submitGuidance} id="create-app-guidance">
              {submitGuidance}
            </p>
          ) : null}
        </div>
      </form>
      {connectionFlow ? (
        <ConnectionDrawer
          flow={connectionFlow}
          onClose={() => setConnectionFlow(null)}
          onStageChange={(stage) =>
            setConnectionFlow((current) =>
              current ? { ...current, stage } : current,
            )
          }
          onConnected={completeConnection}
        />
      ) : null}
    </main>
  );
}

function emptyProvisioning(
  form: BuilderForm,
  requestId: string,
  code?: "feature_disabled" | "provider_unavailable",
): BuilderProvisionResponse {
  const selected = (provider: "github" | "vercel") =>
    provider === "github"
      ? Boolean(form.githubInstallationId)
      : Boolean(form.vercelInstallationId);
  const result = (provider: "github" | "vercel") =>
    selected(provider)
      ? code === "feature_disabled"
        ? ({
            status: "skipped",
            code: "feature_disabled",
            retryable: false,
          } as const)
        : ({
            status: "failed",
            code: "provider_unavailable",
            retryable: true,
          } as const)
      : ({
          status: "skipped",
          code: "not_selected",
          retryable: false,
        } as const);
  return {
    version: 1,
    requestId,
    requestDigest: "0".repeat(64),
    appId: deriveBuilderAppId(form.appName),
    status: "settled",
    github: result("github"),
    vercel: result("vercel"),
    updatedAt: new Date().toISOString(),
  };
}

function provisioningRequest(
  form: BuilderForm,
  requestId: string,
  operation: "github" | "vercel",
) {
  return {
    version: 1 as const,
    requestId,
    operation,
    appName: form.appName,
    repository: { name: form.repository, private: form.privateRepository },
    providers: {
      ...(form.githubInstallationId
        ? { githubInstallationId: form.githubInstallationId }
        : {}),
      ...(form.vercelInstallationId
        ? { vercelInstallationId: form.vercelInstallationId }
        : {}),
    },
  };
}

async function provisionSelectedProvider(
  form: BuilderForm,
  requestId: string,
  operation: "github" | "vercel",
) {
  const response = await fetch("/api/builder/provision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(provisioningRequest(form, requestId, operation)),
  });
  if (!response.ok) throw new Error(`provisioning-${response.status}`);
  return (await response.json()) as BuilderProvisionResponse;
}

export function Handoff({
  form,
  requestId,
  handoffCreationRequestId,
  provisioningEnabled,
  createHandoffTask = createBuilderHandoff,
  onReady,
}: {
  form: BuilderForm;
  requestId: string;
  handoffCreationRequestId: string;
  provisioningEnabled: boolean;
  createHandoffTask?: typeof createBuilderHandoff;
  onReady: (result: {
    provisioning: BuilderProvisionResponse;
    handoff: BuilderHandoffReference;
    handoffAttempt: HandoffAttempt;
    clipboardState: ClipboardState;
  }) => void;
}) {
  const completedAttempt = useRef(-1);
  const mounted = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [handoffError, setHandoffError] = useState(false);
  const stages = [
    ...(form.githubInstallationId ? ["Creating GitHub repository"] : []),
    ...(form.vercelInstallationId ? ["Creating Vercel project"] : []),
    "Preparing secure handoff",
    "Copying handoff prompt",
    "Opening selected client",
  ];
  const [step, setStep] = useState(0);
  useEffect(() => {
    mounted.current = true;
    if (completedAttempt.current === attempt)
      return () => {
        mounted.current = false;
      };
    completedAttempt.current = attempt;
    setHandoffError(false);
    setStep(0);
    void (async () => {
      let provisioning = emptyProvisioning(
        form,
        requestId,
        provisioningEnabled ? "provider_unavailable" : "feature_disabled",
      );
      if (provisioningEnabled) {
        if (form.githubInstallationId) {
          try {
            provisioning = await provisionSelectedProvider(
              form,
              requestId,
              "github",
            );
          } catch {
            if (form.vercelInstallationId)
              provisioning = {
                ...provisioning,
                vercel: {
                  status: "skipped",
                  code: "github_required",
                  retryable: false,
                },
              };
          }
          if (!mounted.current) return;
          setStep((value) => value + 1);
        }
        if (form.vercelInstallationId) {
          if (
            !form.githubInstallationId ||
            provisioning.github.status === "succeeded"
          ) {
            try {
              provisioning = await provisionSelectedProvider(
                form,
                requestId,
                "vercel",
              );
            } catch {}
          }
          if (!mounted.current) return;
          setStep((value) => value + 1);
        }
      }
      if (!mounted.current) return;
      setStep((value) => value + 1);
      let handoff: BuilderHandoffReference;
      try {
        handoff = await createHandoffTask({
          form,
          provisioning,
          creationRequestId: handoffCreationRequestId,
        });
      } catch {
        if (mounted.current) setHandoffError(true);
        return;
      }
      if (!mounted.current) return;
      setStep((value) => value + 1);
      let clipboardState: ClipboardState = "idle";
      try {
        await navigator.clipboard.writeText(
          buildAppHandoffPrompt(handoff.handoffId),
        );
        clipboardState = "copied";
      } catch {
        clipboardState = "failed";
      }
      if (!mounted.current) return;
      setStep((value) => value + 1);
      const handoffAttempt = attemptAppHandoff(
        form.buildDestination,
        handoff.handoffId,
      );
      setStep(stages.length);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
      if (!mounted.current) return;
      onReady({ provisioning, handoff, handoffAttempt, clipboardState });
    })();
    return () => {
      mounted.current = false;
    };
  }, [
    attempt,
    createHandoffTask,
    form,
    handoffCreationRequestId,
    onReady,
    provisioningEnabled,
    requestId,
    stages.length,
  ]);
  return (
    <BuilderHandoffProgress
      stages={stages}
      step={step}
      handoffError={handoffError}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}

export function Ready({
  form,
  requestId,
  initialHandoff,
  initialProvisioning,
  provisioningEnabled,
  initialAttempt,
  initialClipboardState,
  onReset,
}: {
  form: BuilderForm;
  requestId: string;
  initialHandoff: BuilderHandoffReference;
  initialProvisioning: BuilderProvisionResponse;
  provisioningEnabled: boolean;
  initialAttempt: HandoffAttempt;
  initialClipboardState: ClipboardState;
  onReset: () => void;
}) {
  const command = `codex plugin marketplace add withAutograph/marketplace --ref main
codex plugin marketplace upgrade autograph
codex plugin add app-builder@autograph`;
  const [showInstall, setShowInstall] = useState(true);
  const [retryClipboardState, setRetryClipboardState] =
    useState<ClipboardState>("idle");
  const [handoffAttempt, setHandoffAttempt] =
    useState<HandoffAttempt>(initialAttempt);
  const [provisioning, setProvisioning] = useState(initialProvisioning);
  const [handoff, setHandoff] = useState(initialHandoff);
  const [retrying, setRetrying] = useState<"github" | "vercel">();
  const destination = buildDestinationLabel(form.buildDestination);
  const hasProvisioningFailure = (["github", "vercel"] as const).some(
    (provider) => {
      const selected =
        provider === "github"
          ? Boolean(form.githubInstallationId)
          : Boolean(form.vercelInstallationId);
      return selected && provisioning[provider].status === "failed";
    },
  );
  const continueState =
    retryClipboardState === "idle"
      ? initialClipboardState
      : retryClipboardState;
  const openSelectedClient = () => {
    try {
      void navigator.clipboard
        .writeText(buildAppHandoffPrompt(handoff.handoffId))
        .then(() => setRetryClipboardState("copied"))
        .catch(() => setRetryClipboardState("failed"));
    } catch {
      setRetryClipboardState("failed");
    }
    setHandoffAttempt(
      attemptAppHandoff(form.buildDestination, handoff.handoffId),
    );
  };
  const retryProvider = async (provider: "github" | "vercel") => {
    setRetrying(provider);
    try {
      const refreshed = await provisionSelectedProvider(
        form,
        requestId,
        provider,
      );
      const nextCreationRequestId = crypto.randomUUID();
      const refreshedHandoff = await createBuilderHandoff({
        form,
        provisioning: refreshed,
        creationRequestId: nextCreationRequestId,
      });
      setProvisioning(refreshed);
      setHandoff(refreshedHandoff);
      persistActiveProvisioning({
        version: 1,
        requestId,
        handoffCreationRequestId: nextCreationRequestId,
        form,
        phase: "ready",
        provisioning: refreshed,
        handoff: refreshedHandoff,
      });
      setHandoffAttempt("attempted");
      setRetryClipboardState("idle");
    } catch {
      setRetryClipboardState("failed");
    } finally {
      setRetrying(undefined);
    }
  };
  return (
    <main className={styles.flowPage} id="main-content">
      <section className={styles.readyCard}>
        <h1>
          {hasProvisioningFailure
            ? "App created with an issue"
            : "App Brief Ready!"}
        </h1>
        <p>
          Your brief for <span className={styles.teamDot} />{" "}
          <strong>{form.appName}</strong>{" "}
          {hasProvisioningFailure
            ? "is ready, but one provider still needs attention."
            : "is ready."}
        </p>
        <div
          className={styles.previewPane}
          data-status={hasProvisioningFailure ? "attention" : "ready"}
        >
          <AutographMark compact />
          <strong>{form.appName}</strong>
          <span>
            {hasProvisioningFailure ? (
              <AlertCircle size={12} aria-hidden="true" />
            ) : (
              <i />
            )}
            {hasProvisioningFailure ? "Setup needs attention" : "Ready"}
          </span>
          <button type="button" onClick={openSelectedClient}>
            Open in {destination}
          </button>
        </div>
        <BuilderProvisionedResources
          githubSelected={Boolean(form.githubInstallationId)}
          vercelSelected={Boolean(form.vercelInstallationId)}
          provisioning={provisioning}
          provisioningEnabled={provisioningEnabled}
          retrying={retrying}
          onRetry={(provider) => void retryProvider(provider)}
          providerSetupMessage={providerSetupMessage}
        />
        <p className={styles.continueStatus} role="status" aria-live="polite">
          {handoffAttempt === "attempted"
            ? `Launch requested for ${destination}. If your browser suppressed the custom link, you can retry above.`
            : null}
          {handoffAttempt === "too-long"
            ? `This brief is too long to open automatically in ${destination}.`
            : null}
          {handoffAttempt === "blocked"
            ? `The browser blocked ${destination}. You can open the client manually and paste the brief.`
            : null}
          {continueState === "copied"
            ? " Your brief was copied as a fallback."
            : null}
          {continueState === "failed"
            ? " Clipboard access was blocked. Retry after allowing clipboard access."
            : null}
        </p>
        {showInstall ? (
          <BuilderInstallInstructions
            command={command}
            onDismiss={() => setShowInstall(false)}
          />
        ) : null}
        <BuilderNextSteps onReset={onReset} />
      </section>
    </main>
  );
}

export function AppBuilder({
  authenticated,
  generatedNameSeed = "app-builder",
  connectionsEnabled = false,
  comingSoonEnabled = false,
  provisioningEnabled = false,
  integrations,
  providerNotices = [],
  providerResumeKey,
}: {
  authenticated: boolean;
  generatedNameSeed?: string;
  connectionsEnabled?: boolean;
  comingSoonEnabled?: boolean;
  provisioningEnabled?: boolean;
  integrations: BuilderIntegrationState;
  providerNotices?: ProviderConnectionNotice[];
  providerResumeKey?: string;
}) {
  const router = useRouter();
  const [screen, setScreen] = useState<Screen>("builder");
  const [submitted, setSubmitted] = useState<BuilderForm>();
  const [provisionRequestId, setProvisionRequestId] = useState<string>();
  const [handoffCreationRequestId, setHandoffCreationRequestId] =
    useState<string>();
  const [provisioning, setProvisioning] = useState<BuilderProvisionResponse>();
  const [handoff, setHandoff] = useState<BuilderHandoffReference>();
  const [handoffAttempt, setHandoffAttempt] =
    useState<HandoffAttempt>("attempted");
  const [handoffClipboardState, setHandoffClipboardState] =
    useState<ClipboardState>("idle");
  const [savedBrief, setSavedBrief] = useState("");
  const resumedDraft = useSyncExternalStore(
    () => () => undefined,
    () => (providerResumeKey ? readBuilderDraft(providerResumeKey) : undefined),
    () => undefined,
  );
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setSavedBrief(sessionStorage.getItem("autograph-app-brief") ?? "");
      const active = parseActiveProvisioning(
        sessionStorage.getItem(activeProvisioningStorageKey),
      );
      if (active) {
        setSubmitted(active.form);
        setProvisionRequestId(active.requestId);
        setHandoffCreationRequestId(active.handoffCreationRequestId);
        if (active.phase === "ready" && active.provisioning) {
          setProvisioning(active.provisioning);
          setHandoff(active.handoff);
          setScreen("ready");
          if (active.provisioning.requestDigest !== "0".repeat(64))
            void fetch(
              `/api/builder/provision?requestId=${encodeURIComponent(active.requestId)}`,
              { cache: "no-store" },
            )
              .then(async (response) =>
                response.ok
                  ? ((await response.json()) as BuilderProvisionResponse)
                  : undefined,
              )
              .then((response) => {
                if (!response) return;
                setProvisioning(response);
                persistActiveProvisioning({
                  ...active,
                  provisioning: response,
                });
              })
              .catch(() => undefined);
        } else {
          setScreen("handoff");
        }
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const builderKey = providerResumeKey
    ? `${providerResumeKey}:${resumedDraft ? "restored" : "pending"}`
    : savedBrief || "new";

  if (!authenticated)
    return (
      <AnonymousBuilder
        onContinue={(value) => {
          sessionStorage.setItem("autograph-app-brief", value);
          router.push("/auth/sign-in?callbackURL=%2F");
        }}
      />
    );
  return (
    <div className={styles.appShell}>
      <Header />
      {screen === "builder" ? (
        <Builder
          key={builderKey}
          initialBrief={savedBrief}
          generatedNameSeed={generatedNameSeed}
          initialDraft={resumedDraft}
          resumeKey={providerResumeKey}
          connectionsEnabled={connectionsEnabled}
          comingSoonEnabled={comingSoonEnabled}
          integrations={integrations}
          providerNotices={providerNotices}
          onCreate={(form) => {
            if (providerResumeKey) clearBuilderDraft(providerResumeKey);
            const requestId = crypto.randomUUID();
            const creationRequestId = crypto.randomUUID();
            persistActiveProvisioning({
              version: 1,
              requestId,
              handoffCreationRequestId: creationRequestId,
              form,
              phase: "handoff",
            });
            setSubmitted(form);
            setProvisionRequestId(requestId);
            setHandoffCreationRequestId(creationRequestId);
            setProvisioning(undefined);
            setHandoff(undefined);
            setHandoffClipboardState("idle");
            setScreen("handoff");
          }}
        />
      ) : null}
      {screen === "handoff" &&
      submitted &&
      provisionRequestId &&
      handoffCreationRequestId ? (
        <Handoff
          form={submitted}
          requestId={provisionRequestId}
          handoffCreationRequestId={handoffCreationRequestId}
          provisioningEnabled={provisioningEnabled}
          onReady={(result) => {
            persistActiveProvisioning({
              version: 1,
              requestId: provisionRequestId,
              handoffCreationRequestId,
              form: submitted,
              phase: "ready",
              provisioning: result.provisioning,
              handoff: result.handoff,
            });
            setProvisioning(result.provisioning);
            setHandoff(result.handoff);
            setHandoffAttempt(result.handoffAttempt);
            setHandoffClipboardState(result.clipboardState);
            setScreen("ready");
          }}
        />
      ) : null}
      {screen === "ready" &&
      submitted &&
      provisionRequestId &&
      provisioning &&
      handoff ? (
        <Ready
          form={submitted}
          requestId={provisionRequestId}
          initialHandoff={handoff}
          initialProvisioning={provisioning}
          provisioningEnabled={provisioningEnabled}
          initialAttempt={handoffAttempt}
          initialClipboardState={handoffClipboardState}
          onReset={() => {
            clearActiveProvisioning();
            setSubmitted(undefined);
            setProvisionRequestId(undefined);
            setHandoffCreationRequestId(undefined);
            setProvisioning(undefined);
            setHandoff(undefined);
            setScreen("builder");
          }}
        />
      ) : null}
    </div>
  );
}
