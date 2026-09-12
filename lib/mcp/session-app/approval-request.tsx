import type { SessionAnswer } from "./view";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function ApprovalRequest({
  description,
  isSubmitting = false,
  onAnswer,
  title,
}: {
  description?: string;
  isSubmitting?: boolean;
  onAnswer: (answer: SessionAnswer) => void;
  title: string;
}) {
  const readyToBuild = title === "Build this app?";
  const supportingCopy = readyToBuild
    ? "This will turn your plan into a working private preview."
    : description;

  return (
    <div className="approval-request">
      <p className="approval-request__eyebrow">Autograph</p>
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
            Make changes
          </button>
          <p className="approval-request__hint">Keep chatting to refine your app.</p>
        </div>
        <button
          type="button"
          className="approval-request__primary"
          disabled={isSubmitting}
          onClick={() => onAnswer({ kind: "approve" })}
        >
          Build app
        </button>
      </div>
    </div>
  );
}
