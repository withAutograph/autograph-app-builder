import type { SessionAnswer } from "./view";

const renderPreviewApprovalDescription = (text: string) =>
  text === "This approval may incur provider costs." ? (
    <em>This approval may incur provider costs.</em>
  ) : (
    text
  );

const ApprovalDescription = ({
  supportingCopy,
  previewApproval,
}: {
  supportingCopy?: string;
  previewApproval: boolean;
}) => {
  const renderApprovalDescription = (text: string) =>
    previewApproval ? renderPreviewApprovalDescription(text) : text;
  return (
    <>
      {supportingCopy !== undefined && supportingCopy !== null && supportingCopy !== "" ? (
        <div className="approval-request__description">
          {supportingCopy.split("\n\n").map((section) => {
            const lines = section.split("\n");
            const heading = lines[0].endsWith(":") ? lines[0].slice(0, -1) : undefined;
            const body = heading === undefined ? lines : lines.slice(1);
            const bullets = body.every((line) => line.startsWith("- "));
            const content = bullets ? (
              <ul>
                {body.map((line) => (
                  <li key={line}>{renderApprovalDescription(line.slice(2))}</li>
                ))}
              </ul>
            ) : (
              <p>{renderApprovalDescription(body.join(" "))}</p>
            );
            const referenceSection = heading?.includes("(provider ") ?? false;
            return referenceSection ? (
              <details key={section}>
                <summary>{heading}</summary>
                {content}
              </details>
            ) : (
              <section key={section}>
                {heading !== undefined && heading !== "" ? <h3>{heading}</h3> : null}
                {content}
              </section>
            );
          })}
        </div>
      ) : null}
    </>
  );
};

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
  const previewApproval = title === "Do you approve creating a preview?";
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

  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
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
      <ApprovalDescription supportingCopy={supportingCopy} previewApproval={previewApproval} />
      <div className="approval-request__actions">
        <div>
          <button
            type="button"
            className="approval-request__secondary"
            disabled={isSubmitting}
            onClick={() =>
              // oxlint-disable-next-line typescript/no-confusing-void-expression -- Preserve the callback return value.
              onAnswer({ kind: "deny" })
            }
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
          onClick={() =>
            // oxlint-disable-next-line typescript/no-confusing-void-expression -- Preserve the callback return value.
            onAnswer({ kind: "approve" })
          }
        >
          {isSubmitting ? "Submitting…" : primaryLabel}
        </button>
      </div>
    </div>
  );
  /* oxlint-enable typescript/strict-boolean-expressions */
}
