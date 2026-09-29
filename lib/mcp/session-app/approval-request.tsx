import type { SessionAnswer } from "./view";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function ApprovalRequest({
  description,
  isSubmitting = false,
  onAnswer,
  title,
  primaryLabel: primaryLabelOverride,
  secondaryLabel: secondaryLabelOverride,
}: {
  description?: string;
  isSubmitting?: boolean;
  onAnswer: (answer: SessionAnswer) => void;
  primaryLabel?: string;
  secondaryLabel?: string;
  title: string;
}) {
  const readyToBuild = title === "Build this app?";
  const publishDraft = title === "Publish the reviewed changes?";
  const supportingCopy = readyToBuild
    ? "This will turn your plan into a working private preview."
    : description;
  const hint = readyToBuild ? "Keep chatting to refine your app." : "Cancel and return to chat.";
  let defaultPrimaryLabel = "Accept";
  if (readyToBuild) {
    defaultPrimaryLabel = "Build app";
  } else if (publishDraft) {
    defaultPrimaryLabel = "Publish draft PR";
  }
  const primaryLabel = primaryLabelOverride ?? defaultPrimaryLabel;
  const secondaryLabel = secondaryLabelOverride ?? (readyToBuild ? "Make changes" : "Cancel");

  return (
    <div className="approval-request">
      <p className="approval-request__eyebrow">Approval required</p>
      <h2>{readyToBuild ? "Ready to build your app?" : title}</h2>
      {supportingCopy ? <p>{supportingCopy}</p> : null}
      <div className="approval-request__actions">
        <div>
          <button
            type="button"
            className="approval-request__secondary"
            disabled={isSubmitting}
            onClick={() => onAnswer({ kind: "deny" })}
          >
            {secondaryLabel}
          </button>
          <p className="approval-request__hint">{hint}</p>
        </div>
        <button
          type="button"
          className="approval-request__primary"
          disabled={isSubmitting}
          aria-busy={isSubmitting}
          aria-live="polite"
          onClick={() => onAnswer({ kind: "approve" })}
        >
          {isSubmitting ? "Submitting…" : primaryLabel}
        </button>
      </div>
    </div>
  );
}
