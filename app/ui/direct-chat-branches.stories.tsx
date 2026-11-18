import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { userEvent, within } from "storybook/test";

import {
  authorizationRequest,
  choiceRequest,
  freeformRequest,
  sessionResult,
} from "@/.storybook/create-app/mcp-fixtures";
import type { EveSessionResult } from "@/lib/mcp/contracts";
import { userFacingErrorSummary } from "@/lib/mcp/public-error-copy";
import { SessionAppView } from "@/lib/mcp/session-app/view";
import "./direct-chat-journey.stories.css";

type Branch =
  | "connect"
  | "question"
  | "waiting"
  | "cancelled"
  | "failed"
  | "unavailable"
  | "approval"
  | "approval-failed"
  | "approval-pending"
  | "batch"
  | "preview-setup"
  | "preview-cleanup"
  | "preview-project"
  | "delayed"
  | "unknown"
  | "identity";

function BranchExample({ branch }: { branch: Branch }) {
  let result: EveSessionResult = sessionResult([]);
  if (branch === "connect") result = sessionResult([authorizationRequest]);
  if (branch === "question" || branch === "unavailable") result = sessionResult([freeformRequest]);
  if (branch === "batch") result = sessionResult([choiceRequest, freeformRequest]);
  if (branch === "preview-setup" || branch === "preview-cleanup" || branch === "preview-project") {
    const cleanup = branch === "preview-cleanup";
    const project = branch === "preview-project";
    result = sessionResult([
      {
        allowFreeform: false,
        kind: "approval",
        requestId: "provider-approval",
        title: project
          ? "Create this app's Preview project?"
          : cleanup
            ? "Remove this app's Preview resources?"
            : "Do you approve creating a preview?",
        description: project
          ? "Create the Preview project vendor-onboarding for the app.\n\nWhat will happen:\n- Reserve a database and access roles for the app. This does not create the database or give anyone access yet.\n\nResource details (provider references):\n- Neon project example, branch preview, store app-data.\n- Reserve database vendor_app and its migration and runtime roles.\n\nAccess and setup:\n- Require sign-in for deployments.\n- Stop if the project name is already taken.\n\nCost and retention:\n- Provider charges may apply to the account owner.\n- The reservation is kept until the owner removes it.\n\nThis does not deploy the app or activate Production."
          : `${cleanup ? "Remove this app’s Preview resources and access created for them." : "Prepare Preview resources and service connections for vendor-onboarding."}\n\nProduction will not be deployed or activated.\n\nWhat will happen:\n- ${cleanup ? "Remove the app’s Preview resources and access." : "Prepare the app’s Preview database and connect sign-in."}\n\nOrganization access:\n- ${cleanup ? "Remove" : "Give"} Avery Chen (avery@example.test) reviewer access in Example.\n\nAccess and cost:\n- ${cleanup ? "Revoke" : "Grant"} app access for Avery Chen (avery@example.test).\n- Provider charges may apply to the account owner.\n\nBilling details (provider owner reference):\n- example-account\n\nRetention:\n- ${cleanup ? "Shared sign-in resources may be retained." : "Preview resources are retained for 30 days and may incur charges until removed."}`,
      },
    ]);
  }
  if (branch === "waiting" || branch === "cancelled") result = { ...result, status: branch };
  if (branch === "failed")
    result = {
      ...result,
      status: "failed",
      error: {
        code: "provider_unavailable",
        message: "The connection could not be confirmed.",
        diagnostic:
          "The connection could not be confirmed. Your progress is saved. Return to this conversation to continue.",
      },
    };
  if (branch === "approval" || branch === "approval-failed" || branch === "approval-pending")
    result = sessionResult([
      {
        allowFreeform: false,
        kind: "approval",
        requestId: "save-draft",
        title: "Save a draft on GitHub?",
        description:
          "Save the reviewed changes as a draft on GitHub in example/vendor-onboarding, based on main. The draft is for review; it will not merge or deploy the changes.",
      },
    ]);
  return (
    <main className="chat-journey">
      <header className="chat-journey-header">
        <strong>Vendor onboarding app</strong>
      </header>
      <div className="chat-journey-transcript">
        <section className="chat-journey-message">
          <strong>Autograph App Builder</strong>
          <div>
            {branch === "unavailable" ? <p>Who will use this app?</p> : null}
            {branch === "delayed" || branch === "unknown" ? (
              <p>
                {userFacingErrorSummary(
                  branch === "delayed" ? "session_read_delayed" : "submission_unknown",
                )}
              </p>
            ) : null}
            {branch !== "delayed" && branch !== "unknown" ? (
              <SessionAppView
                canCallTools={branch !== "unavailable"}
                canOpenLinks
                onOpenLink={fn(async () => {})}
                onRespond={fn(async () => {
                  if (branch === "approval-failed")
                    throw new Error(
                      "The response could not be confirmed. Check the saved conversation before trying again.",
                    );
                  if (branch === "approval-pending") await new Promise(() => {});
                })}
                result={result}
                identityInvitations={
                  branch === "identity"
                    ? [
                        {
                          callId: "connect-account",
                          expiresAt: "2099-01-01T00:00:00Z",
                          url: "https://builder.example.test/sign-in",
                        },
                      ]
                    : []
                }
              />
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}

const meta = {
  component: BranchExample,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Additional situations that may arise in a direct chat. These use the actual Builder card with example data; not every app encounters every branch.",
      },
    },
  },
  title: "Journey/Direct chat/Other situations",
} satisfies Meta<typeof BranchExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Connection: Story = { args: { branch: "connect" }, name: "Connect GitHub" };
export const Question: Story = { args: { branch: "question" }, name: "Answer a question" };
export const Waiting: Story = { args: { branch: "waiting" }, name: "Waiting for you" };
export const Cancelled: Story = { args: { branch: "cancelled" }, name: "Cancelled" };
export const Failure: Story = { args: { branch: "failed" }, name: "Something needs attention" };
export const HostUnavailable: Story = {
  args: { branch: "unavailable" },
  name: "Answer in chat instead",
};
export const SaveDraft: Story = { args: { branch: "approval" }, name: "Save a draft on GitHub" };
export const MultipleQuestions: Story = {
  args: { branch: "batch" },
  name: "Answer several questions",
};
export const SendingApproval: Story = {
  args: { branch: "approval-pending" },
  name: "Sending a decision",
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Save draft" }));
  },
};
export const UnconfirmedApproval: Story = {
  args: { branch: "approval-failed" },
  name: "Decision needs confirmation",
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Save draft" }));
  },
};
export const Identity: Story = {
  args: { branch: "identity" },
  name: "Sign in to connect an account",
};
export const ProtectedPreview: Story = {
  args: { branch: "preview-setup" },
  name: "Optional protected preview · setup approval",
};
export const PreviewCleanup: Story = {
  args: { branch: "preview-cleanup" },
  name: "Optional protected preview · removal approval",
};
export const PreviewProject: Story = {
  args: { branch: "preview-project" },
  name: "Optional protected preview · project approval",
};
export const DelayedProgress: Story = {
  args: { branch: "delayed" },
  name: "Progress is still loading",
};
export const UnknownOutcome: Story = {
  args: { branch: "unknown" },
  name: "Action outcome is unconfirmed",
};
