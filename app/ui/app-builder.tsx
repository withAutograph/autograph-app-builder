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
  GitBranch,
  Github,
  Globe,
  HelpCircle,
  Home,
  Lock,
  LogOut,
  Monitor,
  Moon,
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
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  SiLinear,
  SiNotion,
  SiResend,
  SiSanity,
  SiSlack,
  SiStripe,
  SiVercel,
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
  channelWeb: boolean;
  channelSlack: boolean;
  connections: string[];
};

const connections = [
  ["Linear", "linear"],
  ["Notion", "notion"],
  ["Vercel", "vercel"],
  ["Resend", "resend"],
  ["Stripe", "stripe"],
  ["Sanity", "sanity"],
  ["Kernel", "kernel"],
  ["Custom MCP", "mcp"],
] as const;

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

function ConnectionIcon({ kind }: { kind: (typeof connections)[number][1] }) {
  const icons = {
    linear: SiLinear,
    notion: SiNotion,
    vercel: SiVercel,
    resend: SiResend,
    stripe: SiStripe,
    sanity: SiSanity,
    kernel: Globe,
    mcp: GitBranch,
  };
  const Icon = icons[kind];
  return (
    <span className={styles.connectionIcon} data-kind={kind} aria-hidden="true">
      <Icon size={18} />
    </span>
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
    channelWeb: false,
    channelSlack: false,
    connections: [],
  });
  const [search, setSearch] = useState("");
  const filtered = connections.filter(([name]) =>
    name.toLowerCase().includes(search.toLowerCase()),
  );
  const canSubmit = Boolean(form.brief.trim());
  const toggleConnection = (name: string) =>
    setForm((current) => ({
      ...current,
      connections: current.connections.includes(name)
        ? current.connections.filter((item) => item !== name)
        : [...current.connections, name],
    }));
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
        <label>
          Vercel Team
          <div className={styles.selectControl}>
            <span className={styles.teamDot} />
            autograph<span className={styles.proBadge}>Pro</span>
            <ChevronDown size={16} aria-hidden="true" />
            <select aria-label="Select a Vercel Team" defaultValue="autograph">
              <option value="autograph">autograph</option>
            </select>
          </div>
        </label>
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
        <div className={styles.repoRow}>
          <label>
            Git Scope
            <div className={styles.selectControl}>
              <Github size={16} aria-hidden="true" />
              jasonmorganson
              <ChevronDown size={16} aria-hidden="true" />
              <select aria-label="Git Scope" defaultValue="jasonmorganson">
                <option value="jasonmorganson">jasonmorganson</option>
              </select>
            </div>
          </label>
          <span className={styles.slash} aria-hidden="true">
            /
          </span>
          <label htmlFor="repository-name">
            Private Repository Name
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
              <span>
                <Lock size={13} aria-hidden="true" />
              </span>
            </div>
          </label>
        </div>
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
        <fieldset className={styles.modelField}>
          <legend>Model</legend>
          <label className={styles.checkLine}>
            <input type="checkbox" name="zdr" /> Zero Data Retention{" "}
            <HelpCircle size={12} aria-hidden="true" />
          </label>
          <div className={styles.selectControl}>
            <Search size={16} aria-hidden="true" />
            <span>GPT 5.6 Terra</span>
            <span className={styles.modelId}>openai/gpt-5.6-terra</span>
            <ChevronDown size={16} aria-hidden="true" />
            <select aria-label="Model" defaultValue="openai/gpt-5.6-terra">
              <option value="openai/gpt-5.6-terra">GPT 5.6 Terra</option>
              <option value="openai/gpt-5.6-sol">GPT 5.6 Sol</option>
              <option value="openai/gpt-5.6-luna">GPT 5.6 Luna</option>
            </select>
          </div>
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
            <Search size={16} aria-hidden="true" />
            <span className={styles.srOnly}>Search connections</span>
            <input
              type="search"
              name="connection-search"
              autoComplete="off"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search connections…"
            />
          </label>
          <div className={styles.connectionGrid}>
            {filtered.map(([name, kind]) => (
              <button
                type="button"
                key={name}
                aria-pressed={form.connections.includes(name)}
                onClick={() => toggleConnection(name)}
              >
                <ConnectionIcon kind={kind} />
                {name}
                {form.connections.includes(name) ? (
                  <Check size={15} aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>
          <button
            className={styles.showAll}
            type="button"
            onClick={() => setSearch("")}
          >
            Show all connections
          </button>
        </fieldset>
        <button
          className={styles.createButton}
          type="submit"
          disabled={!canSubmit}
        >
          Create App
        </button>
      </form>
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
