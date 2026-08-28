"use client";

import { useMemo, useState, type ChangeEvent } from "react";

import { CopyIcon } from "../ui/brand";
import styles from "../ui/public-site.module.css";

type Brief = {
  objective: string;
  repository: string;
  constraints: string;
  doneWhen: string;
};

const emptyBrief: Brief = {
  objective: "",
  repository: "",
  constraints: "",
  doneWhen: "",
};

const fields = [
  {
    id: "repository",
    label: "Repository",
    placeholder: "e.g. owner/repo or URL",
  },
  {
    id: "constraints",
    label: "Constraints",
    placeholder: "e.g. tech stack, must-use libraries",
  },
  {
    id: "doneWhen",
    label: "Done when",
    placeholder: "e.g. criteria, tests, acceptance",
  },
] as const;

function formattedBrief(brief: Brief) {
  const lines = [
    "Autograph App Builder brief",
    "",
    "Objective:",
    brief.objective || "[Describe what you want to build]",
  ];
  if (brief.repository) lines.push("", "Repository:", brief.repository);
  if (brief.constraints) lines.push("", "Constraints:", brief.constraints);
  if (brief.doneWhen) lines.push("", "Done when:", brief.doneWhen);
  return lines.join("\n");
}

function PreviewValue({
  value,
  fallback,
}: {
  value: string;
  fallback: string;
}) {
  return value ? (
    <p>{value}</p>
  ) : (
    <div className={styles.previewLines} aria-label={fallback}>
      <span />
      <span />
      <span />
    </div>
  );
}

export function WorkspaceBrief() {
  const [brief, setBrief] = useState<Brief>(emptyBrief);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const clipboardText = useMemo(() => formattedBrief(brief), [brief]);

  function update(event: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) {
    const field = event.currentTarget.name as keyof Brief;
    setBrief((current) => ({ ...current, [field]: event.target.value }));
    setCopyState("idle");
  }

  async function copyBrief() {
    try {
      await navigator.clipboard.writeText(clipboardText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <section className={styles.workspaceMain} aria-labelledby="workspace-title">
      <div className={styles.briefComposer}>
        <h1 id="workspace-title">Start with a clear brief.</h1>
        <p className={styles.workspaceIntro}>
          Shape the objective here, then take it to your connected App Builder
          client.
        </p>
        <form onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="objective">What do you want to build?</label>
          <textarea
            id="objective"
            name="objective"
            value={brief.objective}
            onChange={update}
            placeholder="Describe the product, the people it serves, and the outcome you need."
          />
          <div className={styles.optionalFields}>
            {fields.map((field) => (
              <label key={field.id} htmlFor={field.id}>
                <span>
                  {field.label} <small>Optional</small>
                </span>
                <input
                  id={field.id}
                  name={field.id}
                  value={brief[field.id]}
                  onChange={update}
                  placeholder={field.placeholder}
                />
              </label>
            ))}
          </div>
          <div className={styles.copyRow}>
            <button type="button" onClick={copyBrief}>
              <CopyIcon /> Copy builder brief
            </button>
            <p className={styles.copyStatus} role="status" aria-live="polite">
              {copyState === "copied" ? "Builder brief copied." : null}
              {copyState === "failed"
                ? "Copy isn’t available in this browser."
                : null}
            </p>
          </div>
        </form>
        <p className={styles.boundaryNote}>
          <span aria-hidden="true">i</span>
          Authenticated sessions run through the connected MCP client.
        </p>
      </div>

      <aside className={styles.briefPreview} aria-label="Builder brief preview">
        <h2>Builder brief</h2>
        <div>
          <section>
            <h3>Objective</h3>
            <PreviewValue
              value={brief.objective}
              fallback="Objective appears here"
            />
          </section>
          <section>
            <h3>Repository</h3>
            <PreviewValue
              value={brief.repository}
              fallback="Repository appears here"
            />
          </section>
          <section>
            <h3>Constraints</h3>
            <PreviewValue
              value={brief.constraints}
              fallback="Constraints appear here"
            />
          </section>
          <section>
            <h3>Done when</h3>
            <PreviewValue
              value={brief.doneWhen}
              fallback="Completion criteria appear here"
            />
          </section>
        </div>
      </aside>
      <div className={styles.workspacePath} aria-hidden="true">
        <span />
        <span />
      </div>
    </section>
  );
}
