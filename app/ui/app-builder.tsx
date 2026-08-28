"use client";

import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  DollarSign,
  Edit,
  ExternalLink,
  GitBranch,
  Globe,
  HelpCircle,
  Home,
  Info,
  LogOut,
  Monitor,
  Moon,
  Plus,
  PlusCircle,
  RefreshCw,
  Search,
  Settings,
  Smile,
  Sun,
  X,
} from "@geist-ui/icons";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FaGithub, FaLock, FaLockOpen } from "react-icons/fa";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  SiOracle,
  SiQuickbooks,
  SiSage,
  SiSlack,
  SiXero,
} from "react-icons/si";

import styles from "./app-builder.module.css";
import autographIcon from "../../assets/autograph-icon.png";

type Theme = "system" | "light" | "dark";
type Screen = "builder" | "handoff" | "ready";
type UserSummary = { name: string; email: string };
type BuilderForm = {
  appName: string;
  repository: string;
  brief: string;
  privateRepository: boolean;
  channelWeb: boolean;
  channelSlack: boolean;
  connections: string[];
};
type ConnectionStage = "connect" | "configure" | "customize";
type ConnectionFlow = { name: string; stage: ConnectionStage };

const featuredConnections = [
  ["QuickBooks", "quickbooks"],
  ["Ramp", "ramp"],
  ["NetSuite", "netsuite"],
  ["Xero", "xero"],
  ["Sage Intacct", "sage-intacct"],
] as const;

const allConnectionNames = featuredConnections.map(([name]) => name);

const connectionKind = new Map<string, string>(featuredConnections);

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

const teamOptions = [
  { value: "pylee", label: "pylee", detail: "Hobby" },
  { value: "autograph", label: "autograph", detail: "Pro" },
];

const gitScopeOptions = [
  "jasonmorganson",
  "abstractops",
  "BucephalusTech",
  "clientless-org",
  "fatehai",
  "mcpapp",
  "precasting",
  "pyleeai",
  "withAutograph",
].map((value) => ({ value, label: value }));

const modelOptions = [
  ["bytedance/seed-1.8", "Bytedance Seed 1.8"],
  ["anthropic/claude-3-haiku", "Claude 3 Haiku"],
  ["anthropic/claude-fable-5", "Claude Fable 5"],
  ["anthropic/claude-haiku-4.5", "Claude Haiku 4.5"],
  ["anthropic/claude-opus-4", "Claude Opus 4"],
  ["anthropic/claude-opus-4.5", "Claude Opus 4.5"],
  ["anthropic/claude-opus-4.6", "Claude Opus 4.6"],
  ["anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5"],
  ["deepseek/deepseek-v3.2", "DeepSeek V3.2"],
  ["google/gemini-2.5-flash", "Gemini 2.5 Flash"],
  ["google/gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"],
  ["openai/gpt-5.4", "GPT 5.4"],
  ["openai/gpt-5.4-mini", "GPT 5.4 Mini"],
  ["openai/gpt-5.5", "GPT 5.5"],
  ["openai/gpt-5.6-luna", "GPT 5.6 Luna"],
  ["openai/gpt-5.6-sol", "GPT 5.6 Sol"],
  ["openai/gpt-5.6-terra", "GPT 5.6 Terra"],
  ["meta/llama-4-maverick", "Llama 4 Maverick"],
  ["mistral/mistral-large-3", "Mistral Large 3"],
  ["alibaba/qwen3-coder", "Qwen3 Coder"],
].map(([value, label]) => ({ value, label, detail: value }));

const suggestions = [
  "Build a customer feedback portal",
  "Create an internal operations dashboard",
] as const;

const defaultBrief =
  "# Product\n\nBuild a focused app that helps people complete one important workflow. Define the users, the desired outcome, the repository constraints, and the acceptance criteria. Match the requested product tone and interface, verify assumptions before building, and make the final checks explicit.";

function AutographMark({ compact = false }: { compact?: boolean }) {
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

function InfoTooltip({ children }: { children: string }) {
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

function ConnectionIcon({ kind, name }: { kind?: string; name: string }) {
  const icons = {
    quickbooks: SiQuickbooks,
    ramp: DollarSign,
    netsuite: SiOracle,
    xero: SiXero,
    "sage-intacct": SiSage,
  };
  const Icon = kind ? icons[kind as keyof typeof icons] : undefined;
  return (
    <span
      className={styles.connectionIcon}
      data-kind={kind}
      data-name={name}
      aria-hidden="true"
    >
      {Icon ? <Icon size={18} /> : <Globe size={18} />}
    </span>
  );
}

type ComboOption = {
  value: string;
  label: string;
  detail?: string;
  icon?: string;
};

function SearchCombobox({
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
}: {
  label: string;
  value: string;
  options: ComboOption[];
  onChange: (value: string) => void;
  prefix: ReactNode;
  menuFooter?: ComboOption;
  optionIcon?: (option: ComboOption) => ReactNode;
  footerIcon?: ReactNode;
  detailPills?: boolean;
  showSelectedCheck?: boolean;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected =
    options.find((option) => option.value === value) ?? options[0];
  const [query, setQuery] = useState(selected.label);
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
    setQuery(selected.label);
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
        role="searchbox"
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={`${id}-listbox`}
        value={query}
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
      {selected.detail ? (
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
          <button className={styles.comboFooter} type="button">
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

function AccountMenu({
  theme,
  setTheme,
  close,
  user,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  close: () => void;
  user: UserSummary;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menuRef.current?.focus();
  }, []);
  return (
    <div
      className={styles.accountMenu}
      role="dialog"
      aria-label="Account menu"
      tabIndex={-1}
      ref={menuRef}
      onKeyDown={(event) => event.key === "Escape" && close()}
    >
      <a className={styles.accountIdentity} href="/github/installations">
        <strong>{user.name}</strong>
        <span>{user.email}</span>
        <Settings size={16} aria-hidden="true" />
      </a>
      <div className={styles.menuDivider} />
      <button type="button">
        <span>Feedback</span>
        <Smile size={17} aria-hidden="true" />
      </button>
      <div className={styles.themeRow}>
        <span>Theme</span>
        <div role="radiogroup" aria-label="Select a display theme">
          {(["system", "light", "dark"] as const).map((choice) => {
            const Icon =
              choice === "system" ? Monitor : choice === "light" ? Sun : Moon;
            return (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={theme === choice}
                aria-label={choice}
                onClick={() => setTheme(choice)}
              >
                <Icon size={15} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>
      <Link href="/">
        <span>Home Page</span>
        <Home size={17} aria-hidden="true" />
      </Link>
      <span className={styles.disabledMenuItem} aria-disabled="true">
        <span>Changelog</span>
        <Edit size={17} aria-hidden="true" />
      </span>
      <span className={styles.disabledMenuItem} aria-disabled="true">
        <span>Help</span>
        <HelpCircle size={17} aria-hidden="true" />
      </span>
      <span className={styles.disabledMenuItem} aria-disabled="true">
        <span>Docs</span>
        <BookOpen size={17} aria-hidden="true" />
      </span>
      <form action="/api/auth/sign-out" method="post">
        <button type="submit">
          <span>Log Out</span>
          <LogOut size={17} aria-hidden="true" />
        </button>
      </form>
      <div className={styles.menuDivider} />
      <a className={styles.statusLink} href="/healthz">
        <span>All systems normal.</span>
        <i />
      </a>
    </div>
  );
}

function Header({
  theme,
  setTheme,
  user,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  user: UserSummary;
}) {
  const [open, setOpen] = useState(false);
  return (
    <header className={styles.header}>
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>
      <Link href="/" className={styles.back}>
        <ArrowLeft size={17} aria-hidden="true" /> Back
      </Link>
      <span>New App</span>
      <div className={styles.headerActions}>
        <a href="/github/installations" aria-label="Settings">
          <Settings size={17} aria-hidden="true" />
        </a>
        <button
          className={styles.avatar}
          type="button"
          aria-label="Open account menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {user.name
            .split(/\s+/u)
            .map((part) => part[0])
            .join("")
            .slice(0, 2)
            .toUpperCase() || "AU"}
        </button>
        {open ? (
          <AccountMenu
            theme={theme}
            setTheme={setTheme}
            close={() => setOpen(false)}
            user={user}
          />
        ) : null}
      </div>
    </header>
  );
}

function ConnectionDrawer({
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

function AnonymousBuilder({
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
          <a href="/auth/sign-in?callbackURL=%2F">Login</a>
          <a className={styles.darkButton} href="/auth/sign-in?callbackURL=%2F">
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
          You’ll create or log in to your Autograph account before building.
        </p>
      </section>
    </main>
  );
}

function Builder({
  initialBrief,
  onCreate,
}: {
  initialBrief: string;
  onCreate: (form: BuilderForm) => void;
}) {
  const [form, setForm] = useState<BuilderForm>({
    appName: "",
    repository: "",
    brief: initialBrief || defaultBrief,
    privateRepository: true,
    channelWeb: false,
    channelSlack: false,
    connections: [],
  });
  const [team, setTeam] = useState("autograph");
  const [gitScope, setGitScope] = useState("jasonmorganson");
  const [model, setModel] = useState("openai/gpt-5.6-terra");
  const [search, setSearch] = useState("");
  const [connectionFlow, setConnectionFlow] = useState<ConnectionFlow | null>(
    null,
  );
  const [connectedConnections, setConnectedConnections] = useState<string[]>(
    [],
  );
  const normalizedSearch = search.trim().toLowerCase();
  const filtered = allConnectionNames.filter((name) => {
    if (!normalizedSearch) return true;
    return name.toLowerCase().includes(normalizedSearch);
  });
  const canSubmit = Boolean(form.brief.trim());
  const addConnection = (name: string) =>
    setForm((current) => ({
      ...current,
      connections: current.connections.includes(name)
        ? current.connections
        : [...current.connections, name],
    }));
  const removeConnection = (name: string) => {
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
    if (!form.appName && !form.repository) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [form.appName, form.repository]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSubmit)
      onCreate({
        ...form,
        appName: form.appName.trim() || "support-app",
        repository: form.repository.trim() || "my-app",
      });
  }

  return (
    <main className={styles.authenticatedPage} id="main-content">
      <form className={styles.builderCard} onSubmit={submit}>
        <div className={styles.cardTitle}>
          <h1>Build an app</h1>
          <AutographMark compact />
        </div>
        <label htmlFor="app-name">
          App Name
          <input
            id="app-name"
            name="app-name"
            autoComplete="off"
            spellCheck={false}
            value={form.appName}
            onChange={(event) =>
              setForm({ ...form, appName: event.target.value })
            }
            placeholder="support-app"
          />
        </label>
        <label htmlFor="app-brief">
          App Brief
          <div className={styles.briefField}>
            <textarea
              id="app-brief"
              name="app-brief"
              autoComplete="off"
              value={form.brief}
              onChange={(event) =>
                setForm({ ...form, brief: event.target.value })
              }
              placeholder="# Product\n\nDescribe the app you want to build…"
            />
            <button
              type="button"
              aria-label="Try another app brief example"
              onClick={() => setForm({ ...form, brief: defaultBrief })}
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
        <label>
          Vercel Team
          <SearchCombobox
            label="Select a Vercel Team"
            value={team}
            options={teamOptions}
            onChange={setTeam}
            prefix={<span className={styles.teamDot} data-team={team} />}
            menuFooter={{ value: "create-team", label: "Create a Team" }}
            optionIcon={(option) => (
              <span className={styles.teamDot} data-team={option.value} />
            )}
            footerIcon={<PlusCircle size={18} />}
            detailPills
          />
        </label>
        <div className={styles.repoRow}>
          <label>
            Git Scope
            <SearchCombobox
              label="Git Scope"
              value={gitScope}
              options={gitScopeOptions}
              onChange={setGitScope}
              prefix={<FaGithub size={16} />}
              menuFooter={{ value: "add-github", label: "Add GitHub Scope" }}
              optionIcon={() => <FaGithub size={16} />}
              footerIcon={<Plus size={21} />}
            />
          </label>
          <span className={styles.slash} aria-hidden="true">
            /
          </span>
          <div className={styles.repoLabel}>
            {form.privateRepository ? "Private" : "Public"} Repository Name
            <div className={styles.lockedInput}>
              <input
                id="repository-name"
                name="repository-name"
                autoComplete="off"
                spellCheck={false}
                value={form.repository}
                onChange={(event) =>
                  setForm({ ...form, repository: event.target.value })
                }
                placeholder="my-app"
              />
              <label
                className={styles.privacyToggle}
                aria-label="Private repository"
              >
                <input
                  type="checkbox"
                  checked={form.privateRepository}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      privateRepository: event.target.checked,
                    })
                  }
                />
                <span>
                  <i>
                    {form.privateRepository ? (
                      <FaLock size={11} />
                    ) : (
                      <FaLockOpen size={12} />
                    )}
                  </i>
                </span>
                <em role="tooltip">
                  This repository will be{" "}
                  {form.privateRepository ? "private" : "public"}.
                </em>
              </label>
            </div>
          </div>
        </div>
        <fieldset className={styles.modelField}>
          <legend>Model</legend>
          <label className={styles.checkLine}>
            <input type="checkbox" name="zdr" /> Zero Data Retention
            <InfoTooltip>
              Only use providers that support Zero Data Retention.
            </InfoTooltip>
          </label>
          <SearchCombobox
            label={
              modelOptions.find((option) => option.value === model)?.label ??
              "Select model"
            }
            value={model}
            options={modelOptions}
            onChange={setModel}
            prefix={<Search size={15} />}
            showSelectedCheck={false}
          />
        </fieldset>
        <fieldset className={styles.sectionField}>
          <legend>Channels</legend>
          <p>Choose where people can use this app.</p>
          <div className={styles.optionGrid}>
            <label>
              <Globe size={18} aria-hidden="true" />
              Web Chat
              <input
                type="checkbox"
                checked={form.channelWeb}
                onChange={(event) =>
                  setForm({ ...form, channelWeb: event.target.checked })
                }
              />
            </label>
            <label>
              <SiSlack size={18} aria-hidden="true" />
              Slack
              <input
                type="checkbox"
                checked={form.channelSlack}
                onChange={(event) =>
                  setForm({ ...form, channelSlack: event.target.checked })
                }
              />
            </label>
          </div>
        </fieldset>
        <fieldset className={styles.sectionField}>
          <legend>Connections</legend>
          <p>Give this app access to tools and data from other services.</p>
          <label className={styles.searchBox}>
            <Search size={15} aria-hidden="true" />
            <span className={styles.srOnly}>Search connections</span>
            <input
              type="search"
              name="connection-search"
              autoComplete="off"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => event.key === "Escape" && setSearch("")}
              placeholder="Search connections…"
            />
            {search ? (
              <button type="button" onClick={() => setSearch("")}>
                Esc
              </button>
            ) : null}
          </label>
          <div className={styles.connectionGrid}>
            {filtered
              .filter((name) => !form.connections.includes(name))
              .map((name) => (
                <button
                  type="button"
                  key={name}
                  aria-label={`Add ${name}`}
                  onClick={() => addConnection(name)}
                >
                  <ConnectionIcon kind={connectionKind.get(name)} name={name} />
                  {name}
                </button>
              ))}
          </div>
          {form.connections.length ? (
            <div
              className={styles.connectedList}
              aria-label="Added connections"
            >
              {form.connections.map((name) => (
                <article key={name}>
                  <span>
                    <ConnectionIcon
                      kind={connectionKind.get(name)}
                      name={name}
                    />
                  </span>
                  <div>
                    <strong>{name}</strong>
                    <p>{connectionDescription(name)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setConnectionFlow({
                        name,
                        stage: connectedConnections.includes(name)
                          ? "configure"
                          : "connect",
                      })
                    }
                  >
                    {connectedConnections.includes(name)
                      ? "Customize"
                      : "Connect"}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    onClick={() => removeConnection(name)}
                  >
                    <X size={17} />
                  </button>
                </article>
              ))}
            </div>
          ) : null}
        </fieldset>
        <button
          className={styles.createButton}
          type="submit"
          disabled={!canSubmit}
        >
          Create App
        </button>
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

function Handoff({ onReady }: { onReady: () => void }) {
  const [step, setStep] = useState(0);
  const stages = [
    "Preparing App Brief",
    "Validating Inputs",
    "Copying App Brief",
    "Opening Connected Client",
  ];
  useEffect(() => {
    if (step >= stages.length) {
      const done = window.setTimeout(onReady, 500);
      return () => window.clearTimeout(done);
    }
    const timer = window.setTimeout(() => setStep((value) => value + 1), 700);
    return () => window.clearTimeout(timer);
  }, [step, stages.length, onReady]);
  return (
    <main className={styles.flowPage} id="main-content">
      <section className={styles.deploymentCard}>
        <div className={styles.deploymentBody}>
          <h1>Handoff</h1>
          <p className={styles.creating}>
            <span className={styles.spinner} aria-hidden="true" />
            Preparing your app brief… <span>{Math.min(step + 1, 4)}s</span>
          </p>
          <div className={styles.stageList}>
            {stages.map((stage, index) => (
              <div
                key={stage}
                data-active={index === step}
                data-complete={index < step}
              >
                {index < step ? (
                  <Check size={17} aria-hidden="true" />
                ) : index === step ? (
                  <span className={styles.spinner} aria-hidden="true" />
                ) : (
                  <Clock size={18} aria-hidden="true" />
                )}
                <span>{stage}</span>
                {index > 0 ? (
                  <ChevronRight size={17} aria-hidden="true" />
                ) : null}
              </div>
            ))}
          </div>
        </div>
        <footer>
          <SiSlack size={18} aria-hidden="true" /> Tip: Continue the build in
          your connected AI workspace.
        </footer>
      </section>
      <p className={styles.liveStatus} role="status" aria-live="polite">
        {stages[Math.min(step, stages.length - 1)]}
      </p>
    </main>
  );
}

function Ready({ form, onReset }: { form: BuilderForm; onReset: () => void }) {
  const command = "$ npx plugins add withAutograph/autograph-app-builder";
  const [showInstall, setShowInstall] = useState(true);
  const [continueState, setContinueState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  return (
    <main className={styles.flowPage} id="main-content">
      <section className={styles.readyCard}>
        <h1>App Brief Ready!</h1>
        <p>
          Your brief for <span className={styles.teamDot} />{" "}
          <strong>{form.appName}</strong> is ready.
        </p>
        <div className={styles.previewPane}>
          <AutographMark compact />
          <strong>{form.appName}</strong>
          <span>
            <i /> Ready
          </span>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(form.brief);
                setContinueState("copied");
              } catch {
                setContinueState("failed");
              }
            }}
          >
            Continue with Autograph
          </button>
        </div>
        <p className={styles.continueStatus} role="status" aria-live="polite">
          {continueState === "copied"
            ? "App brief copied. Continue in your connected client."
            : null}
          {continueState === "failed"
            ? "Copy failed. Return to the form and copy the brief manually."
            : null}
        </p>
        {showInstall ? (
          <section className={styles.installCard}>
            <div>
              <h2>Install App Builder Plugin</h2>
              <button
                type="button"
                aria-label="Dismiss install instructions"
                onClick={() => setShowInstall(false)}
              >
                <X size={17} aria-hidden="true" />
              </button>
            </div>
            <p>
              Turn your coding agent into an Autograph expert. Copy and run this
              in your terminal to install the plugin.
            </p>
            <div className={styles.command}>
              <code>{command}</code>
              <button
                type="button"
                aria-label="Copy install command"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(command);
                    setCopyState("copied");
                  } catch {
                    setCopyState("failed");
                  }
                }}
              >
                <Copy size={17} aria-hidden="true" />
              </button>
            </div>
            <span role="status" aria-live="polite">
              {copyState === "copied" ? "Install command copied." : null}
              {copyState === "failed"
                ? "Copy failed. Select and copy the command manually."
                : null}
            </span>
          </section>
        ) : null}
        <h2 className={styles.nextTitle}>Next Steps</h2>
        <div className={styles.nextSteps}>
          <div>
            <span>
              <GitBranch size={17} aria-hidden="true" />
            </span>
            <p>
              <strong>Start a New Task</strong>Paste your prepared brief into
              your connected client.
            </p>
          </div>
          <div>
            <span>
              <DollarSign size={17} aria-hidden="true" />
            </span>
            <p>
              <strong>Review the Plan</strong>Approve only the changes you want
              to make.
            </p>
            <ChevronRight size={18} aria-hidden="true" />
          </div>
          <div>
            <span>
              <Globe size={17} aria-hidden="true" />
            </span>
            <p>
              <strong>Connect a Repository</strong>Choose the exact repository
              for the app.
            </p>
            <ChevronRight size={18} aria-hidden="true" />
          </div>
          <div>
            <span>
              <Check size={17} aria-hidden="true" />
            </span>
            <p>
              <strong>Validate the Build</strong>Confirm the acceptance criteria
              in your connected client.
            </p>
            <ChevronRight size={18} aria-hidden="true" />
          </div>
        </div>
        <button className={styles.createButton} type="button" onClick={onReset}>
          Create Another App
        </button>
      </section>
    </main>
  );
}

export function AppBuilder({
  authenticated,
  user,
}: {
  authenticated: boolean;
  user: UserSummary;
}) {
  const router = useRouter();
  const [theme, setTheme] = useState<Theme>("system");
  const [screen, setScreen] = useState<Screen>("builder");
  const [submitted, setSubmitted] = useState<BuilderForm>();
  const [savedBrief, setSavedBrief] = useState("");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setSavedBrief(sessionStorage.getItem("autograph-app-brief") ?? "");
      const storedTheme = window.localStorage?.getItem("autograph-theme");
      if (
        storedTheme === "system" ||
        storedTheme === "light" ||
        storedTheme === "dark"
      ) {
        setTheme(storedTheme);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme =
      theme === "system" ? "light dark" : theme;
    window.localStorage?.setItem("autograph-theme", theme);
  }, [theme]);

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
      <Header theme={theme} setTheme={setTheme} user={user} />
      {screen === "builder" ? (
        <Builder
          key={savedBrief || "new"}
          initialBrief={savedBrief}
          onCreate={async (form) => {
            setSubmitted(form);
            try {
              await navigator.clipboard.writeText(
                `Autograph App Builder brief\n\nApp Name:\n${form.appName}\n\nRepository:\n${form.repository}\n\nApp Brief:\n${form.brief}`,
              );
            } catch {}
            setScreen("handoff");
          }}
        />
      ) : null}
      {screen === "handoff" ? (
        <Handoff onReady={() => setScreen("ready")} />
      ) : null}
      {screen === "ready" && submitted ? (
        <Ready form={submitted} onReset={() => setScreen("builder")} />
      ) : null}
    </div>
  );
}
