import { Monitor } from "@geist-ui/icons";
import type { ReactNode } from "react";
import { SiOpenai } from "react-icons/si";

import { SectionShell } from "../../components/create-app/choice-card";
import styles from "./app-builder.module.css";
import type { BuildDestination } from "./builder-types";

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
