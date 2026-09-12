"use client";

import { Check, ChevronDown, ExternalLink, Globe, Search, X } from "@geist-ui/icons";
import Image from "next/image";
import { useEffect, useState } from "react";
import { SiQuickbooks, SiSage, SiXero } from "react-icons/si";
import { SectionShell } from "../../components/create-app/choice-card";
import autographIcon from "../../assets/autograph-icon.png";
import styles from "./app-builder.module.css";

export type ConnectionStage = "connect" | "configure" | "customize";
export interface ConnectionFlow {
  name: string;
  stage: ConnectionStage;
}

const featuredConnections = [
  ["QuickBooks", "quickbooks"],
  ["Ramp", "ramp"],
  ["NetSuite", "netsuite"],
  ["Xero", "xero"],
  ["Sage Intacct", "sage-intacct"],
] as const;

const allConnectionNames = featuredConnections.map(([name]) => name);
export const comingSoonConnections = new Set(["Ramp", "NetSuite", "Xero", "Sage Intacct"]);

const connectionKind = new Map<string, string>(featuredConnections);

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

export function ConnectionsSection({
  bare = false,
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
  bare?: boolean;
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
  const controls = (
    <>
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
            if (comingSoon && !comingSoonEnabled) {
              return null;
            }
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
    </>
  );
  return bare ? (
    controls
  ) : (
    <SectionShell
      className={`${styles.sectionField} ${styles.connectionsSection}`}
      section="connections"
      title="Connections"
      description="Give this app access to tools and data from other services."
    >
      {controls}
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
    flow.name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-"),
  );
  const [description, setDescription] = useState(connectionDescription(flow.name));
  const accountLabel = flow.name === "Slack" ? "Slack Workspace" : "Account";

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  if (showSuccess) {
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
  }

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
