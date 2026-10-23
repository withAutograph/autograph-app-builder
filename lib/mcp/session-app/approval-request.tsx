import type { SessionAnswer } from "./view";

const renderInlineEmphasis = (text: string) =>
  text
    .split(/(\*[^*\n]+\*)/gu)
    .map((part, index) =>
      /^\*[^*\n]+\*$/u.test(part) ? <em key={index}>{part.slice(1, -1)}</em> : part,
    );

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
  const previewApproval = title === "Do you approve creating a preview environment?";
  const supportingCopy =
    description ??
    (readyToBuild
      ? "Build and validate the app shown above in your private workspace. This does not publish or deploy it."
      : undefined);
  const hint = readyToBuild ? "Keep chatting to refine your app." : "Cancel and return to chat.";
  let defaultPrimaryLabel = "Accept";
  if (readyToBuild) {
    defaultPrimaryLabel = "Build app";
  } else if (publishDraft) {
    defaultPrimaryLabel = "Publish draft PR";
  }
  const primaryLabel = primaryLabelOverride ?? (previewApproval ? "Approve" : defaultPrimaryLabel);
  const secondaryLabel = secondaryLabelOverride ?? (readyToBuild ? "Make changes" : "Cancel");

  return (
    <div className={`approval-request${previewApproval ? " approval-request--preview" : ""}`}>
      {previewApproval ? (
        <>
          <h2 className="approval-request__label">Approval required</h2>
          <p className="approval-request__supporting-title">{title}</p>
        </>
      ) : (
        <>
          <p className="approval-request__eyebrow">Approval required</p>
          <h2>{readyToBuild ? "Ready to build your app?" : title}</h2>
        </>
      )}
      {supportingCopy ? (
        <div className="approval-request__description">
          {supportingCopy.split("\n\n").map((section) => {
            const lines = section.split("\n");
            const heading = lines[0].endsWith(":") ? lines[0].slice(0, -1) : undefined;
            const body = heading === undefined ? lines : lines.slice(1);
            const bullets = body.every((line) => line.startsWith("- "));
            const content = bullets ? (
              <ul>
                {body.map((line) => (
                  <li key={line}>{renderInlineEmphasis(line.slice(2))}</li>
                ))}
              </ul>
            ) : (
              <p>{renderInlineEmphasis(body.join(" "))}</p>
            );
            const referenceSection = heading?.includes("(provider ") ?? false;
            return referenceSection ? (
              <details key={section}>
                <summary>{heading}</summary>
                {content}
              </details>
            ) : (
              <section key={section}>
                {heading ? <h3>{heading}</h3> : null}
                {content}
              </section>
            );
          })}
        </div>
      ) : null}
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
          {previewApproval ? null : <p className="approval-request__hint">{hint}</p>}
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
