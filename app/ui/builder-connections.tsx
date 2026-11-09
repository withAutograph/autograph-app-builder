"use client";

import { Check, ChevronDown, ExternalLink, Globe, Search, X } from "@geist-ui/icons";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { SiQuickbooks, SiSage, SiXero } from "react-icons/si";
import { SectionShell } from "../../components/create-app/choice-card";
import autographIcon from "../../assets/autograph-icon.png";
import styles from "./app-builder.module.css";
import { comingSoonConnections } from "./builder-connection-availability";

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

const connectionKind = new Map<string, string>(featuredConnections);

// oxlint-disable-next-line anti-slop/no-known-value-widening -- Keep the dictionary open for the supported keys.
const connectionDescriptions: Record<string, string> = {
  NetSuite: "Import vendor data from a NetSuite account",
  QuickBooks: "Import mapped vendors, bills, and vendor credits",
  Ramp: "Import authorized transactions and vendor data",
  "Sage Intacct": "Import vendor data from a Sage Intacct company",
  Xero: "Import suppliers, invoices, and credit data",
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function connectionDescription(name: string) {
  return connectionDescriptions[name] ?? `Connect ${name} tools and data to your app`;
}

const connectionIcons = {
  quickbooks: SiQuickbooks,
  "sage-intacct": SiSage,
  xero: SiXero,
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function ConnectionIcon({ kind, name }: { kind?: string; name: string }) {
  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing assertion at this boundary.
  const Icon = kind ? connectionIcons[kind as keyof typeof connectionIcons] : undefined;
  /* oxlint-enable typescript/strict-boolean-expressions */
  const hasBrandAsset = kind === "ramp" || kind === "netsuite";
  return (
    <span className={styles.connectionIcon} data-kind={kind} data-name={name} aria-hidden="true">
      {Icon ? <Icon size={18} /> : null}
      {!Icon && !hasBrandAsset ? <Globe size={18} /> : null}
    </span>
  );
}

// oxlint-disable-next-line sonarjs/function-name, eslint/func-style -- React components use PascalCase names for JSX and diagnostics. Preserve function declaration hoisting and initialization timing.
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
  const selectedNames = new Set(selected);
  const connectedNames = new Set(connected);
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
          onChange={(event) =>
            // oxlint-disable-next-line typescript/no-confusing-void-expression -- Preserve the callback return value.
            onSearchChange(event.target.value)
          }
          onKeyDown={(event) =>
            // oxlint-disable-next-line typescript/strict-void-return -- Preserve the existing callback return contract.
            event.key === "Escape" &&
            // oxlint-disable-next-line typescript/no-confusing-void-expression -- Preserve the callback return value.
            onSearchChange("")
          }
          placeholder="Search connections…"
        />
        {search ? (
          <button
            type="button"
            onClick={() =>
              // oxlint-disable-next-line typescript/no-confusing-void-expression -- Preserve the callback return value.
              onSearchChange("")
            }
          >
            Esc
          </button>
        ) : null}
      </label>
      <div className={styles.connectionGrid}>
        {available.flatMap((name) => {
          if (selectedNames.has(name)) {
            return [];
          }
          const comingSoon = comingSoonConnections.has(name);
          if (comingSoon && !comingSoonEnabled) {
            return [null];
          }
          return [
            <button
              type="button"
              key={name}
              aria-label={comingSoon ? `${name} coming soon` : `Add ${name}`}
              disabled={comingSoon}
              onClick={() =>
                // oxlint-disable-next-line typescript/no-confusing-void-expression -- Preserve the callback return value.
                onAdd(name)
              }
            >
              <ConnectionIcon kind={connectionKind.get(name)} name={name} />
              {name}
              {comingSoon ? <span className={styles.comingSoon}>Coming soon</span> : null}
            </button>,
          ];
        })}
      </div>
      {!showMore && !search ? (
        <button className={styles.showAll} type="button" onClick={onShowMore}>
          Show more connections
        </button>
      ) : null}
      {selected.length ? (
        <div className={styles.connectedList} role="group" aria-label="Added connections">
          {selected.map((name) => (
            <article key={name}>
              <span>
                <ConnectionIcon kind={connectionKind.get(name)} name={name} />
              </span>
              <div>
                <strong>{name}</strong>
                <p>{connectionDescription(name)}</p>
              </div>
              <button
                type="button"
                onClick={() =>
                  // oxlint-disable-next-line typescript/no-confusing-void-expression -- Preserve the callback return value.
                  onCustomize(name)
                }
              >
                {connectedNames.has(name) ? "Customize" : "Connect"}
              </button>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                onClick={() =>
                  // oxlint-disable-next-line typescript/no-confusing-void-expression -- Preserve the callback return value.
                  onRemove(name)
                }
              >
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
  const [connectionName, setConnectionName] = useState(() =>
    flow.name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-"),
  );
  const [description, setDescription] = useState(() => connectionDescription(flow.name));
  const accountLabel = flow.name === "Slack" ? "Slack Workspace" : "Account";
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    // oxlint-disable-next-line typescript/consistent-return -- Preserve conditional dialog effect cleanup.
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [showSuccess]);

  if (showSuccess) {
    return (
      <dialog
        ref={dialogRef}
        className={styles.connectionSuccess}
        aria-label="Connection successful"
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
        style={{
          border: 0,
          height: "100%",
          margin: 0,
          maxHeight: "none",
          maxWidth: "none",
          padding: 0,
          width: "100%",
        }}
      >
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
      </dialog>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.drawerBackdrop}
      aria-labelledby="connection-drawer-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      style={{
        border: 0,
        height: "100%",
        margin: 0,
        maxHeight: "none",
        maxWidth: "none",
        padding: 0,
        width: "100%",
      }}
    >
      <div className={styles.connectionDrawer}>
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
              <button
                type="button"
                onClick={() => {
                  setShowSuccess(true);
                }}
              >
                Connect {flow.name} <ExternalLink size={14} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className={styles.configureFields}>
              <div className={styles.accountField}>
                <span id="connection-account-label">{accountLabel}</span>
                <button
                  type="button"
                  className={styles.accountSelect}
                  aria-labelledby="connection-account-label connection-account-value"
                >
                  <ConnectionIcon kind={connectionKind.get(flow.name)} name={flow.name} />
                  <span id="connection-account-value">Autograph</span>
                  <ChevronDown size={16} aria-hidden="true" />
                </button>
              </div>
              <label>
                <span>
                  Connection Name <em>*</em>
                </span>
                <input
                  value={connectionName}
                  onChange={(event) => {
                    setConnectionName(event.target.value);
                  }}
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
                  onClick={() =>
                    // oxlint-disable-next-line typescript/no-confusing-void-expression -- Preserve the callback return value.
                    onStageChange("customize")
                  }
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
                  onChange={(event) => {
                    setConnectionName(event.target.value);
                  }}
                />
              </label>
              <label>
                Description
                <textarea
                  value={description}
                  onChange={(event) => {
                    setDescription(event.target.value);
                  }}
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
    </dialog>
  );
}
