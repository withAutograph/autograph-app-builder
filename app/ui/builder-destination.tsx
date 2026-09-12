import { Monitor } from "@geist-ui/icons";
import type { ReactNode } from "react";

import { SectionShell } from "../../components/create-app/choice-card";
import styles from "./app-builder.module.css";
import type { BuildDestination } from "./builder-types";

function CursorMark() {
  const controls = (
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
        <Monitor size={18} aria-hidden="true" />
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
  );
  if (bare)
    return (
      <>
        {controls}
        {children}
      </>
    );
  return (
    <>
      <SectionShell
        className={`${styles.sectionField} ${styles.buildSection}`}
        section="build-with"
        title="Build with"
        description="Where do you want to build this app?"
      >
        {controls}
      </SectionShell>
      {children}
    </>
  );
}
