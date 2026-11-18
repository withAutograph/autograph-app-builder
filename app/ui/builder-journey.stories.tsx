import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ReactNode } from "react";
import { fn } from "storybook/test";

import { storybookAuthenticatedSession } from "@/.storybook/auth-session";
import { storyForm, storyIntegrations } from "@/.storybook/create-app/app-builder-fixtures";
import {
  authorizationRequest,
  freeformRequest,
  sessionResult,
} from "@/.storybook/create-app/mcp-fixtures";
import { SignIn } from "@/components/auth/sign-in";
import { SignUp } from "@/components/auth/sign-up";
import { SessionAppView } from "@/lib/mcp/session-app/view";
import type { PublicInputRequest } from "@/lib/mcp/contracts";
import { AnonymousBrief } from "./anonymous-brief";
import { AnonymousBuilderShell } from "./anonymous-builder-shell";
import { AuthenticatedBuilder } from "./authenticated-builder";
import { Header } from "./builder-shell";
import { HandoffControls } from "./handoff-controls";
import { WorkspaceSetupStatus } from "./workspace-setup-status";
import styles from "./app-builder.module.css";
import handoffStyles from "./handoff.module.css";
import "./builder-journey.stories.css";

const brief = storyForm.brief;
const handoff = {
  cursorInstallReady: true,
  destination: "codex" as const,
  expiresAt: "2030-01-01T00:00:00.000Z",
  handoffId: "123e4567-e89b-42d3-a456-426614174001",
  mcpUrl: "https://builder.example/mcp",
  status: "prepared" as const,
  version: 1 as const,
};
const draft = {
  version: 1 as const,
  form: storyForm,
  team: "Autograph",
  gitScope: "withAutograph",
  model: storyForm.modelId,
  zdrOnly: false,
  showMoreConnections: false,
  search: "",
  connectedConnections: [],
  focusOrigin: "github" as const,
  appNameEditedByUser: true,
  repositoryEditedByUser: true,
};
const buildApproval: PublicInputRequest = {
  allowFreeform: false,
  kind: "approval",
  requestId: "build",
  title: "Build this app?",
};
const deliveryApproval: PublicInputRequest = {
  allowFreeform: false,
  description:
    "Update the existing draft on GitHub in example/vendor-onboarding with the reviewed changes. It will remain a draft for review; this will not merge or deploy the changes.",
  kind: "approval",
  requestId: "delivery",
  title: "Update the draft on GitHub?",
};

function ClientExample({ children, message }: { children?: ReactNode; message: string }) {
  return (
    <main className="journey-client">
      <p className="journey-label">
        Illustrative client conversation · wording and host interface vary
      </p>
      <div className="journey-message">
        <strong>Autograph App Builder</strong>
        <p>{message}</p>
      </div>
      {children}
    </main>
  );
}

function Request({ request }: { request: PublicInputRequest }) {
  return (
    <SessionAppView
      canCallTools
      canOpenLinks
      onOpenLink={fn(async () => {})}
      onRespond={fn(async () => {})}
      result={sessionResult([request])}
    />
  );
}

function Journey({ step }: { step: string }) {
  switch (step) {
    case "brief":
      return (
        <AnonymousBuilderShell>
          <AnonymousBrief onContinue={fn()} />
        </AnonymousBuilderShell>
      );
    case "signin":
      return (
        <main className="flex min-h-svh items-center justify-center p-6">
          <SignIn socialPosition="top" />
        </main>
      );
    case "signup":
      return (
        <main className="flex min-h-svh items-center justify-center p-6">
          <SignUp />
        </main>
      );
    case "workspace":
      return <WorkspaceSetupStatus status="loading" />;
    case "configure":
      return (
        <div className={styles.appShell}>
          <Header />
          <AuthenticatedBuilder
            integrations={storyIntegrations}
            initialDurableDraft={draft}
            connectionsEnabled
            provisioningEnabled
          />
        </div>
      );
    case "handoff":
      return (
        <div className={styles.appShell}>
          <Header />
          <main id="main-content" className={styles.flowPage}>
            <section className={`${styles.readyCard} ${handoffStyles.card}`}>
              <h1>Vendor Portal</h1>
              <p>Your prepared app and existing provider connections are saved with Autograph.</p>
              <div className={handoffStyles.resources} aria-label="Prepared resources">
                <article>
                  <div>
                    <strong>GitHub repository</strong>
                    <span>withAutograph/vendor-portal (Private)</span>
                  </div>
                </article>
              </div>
              <details>
                <summary>Prepared brief</summary>
                <p>{brief}</p>
              </details>
              <HandoffControls initial={handoff} />
            </section>
          </main>
        </div>
      );
    case "connect":
      return (
        <ClientExample message="If repository access is needed, connect GitHub and return to the conversation.">
          <Request request={authorizationRequest} />
        </ClientExample>
      );
    case "questions":
      return (
        <ClientExample message="Builder discusses the requested app and asks for information when it is needed.">
          <Request request={freeformRequest} />
        </ClientExample>
      );
    case "prototype":
      return (
        <ClientExample message="Review the proposed app and its prototype in your client. You can describe changes before approving the build.">
          <p className="journey-note">
            The prototype is generated for each app and is not reproduced by this fixture.
          </p>
        </ClientExample>
      );
    case "approve":
      return (
        <ClientExample message="When the proposal is ready, choose whether to build it or keep refining it.">
          <Request request={buildApproval} />
        </ClientExample>
      );
    case "building":
      return (
        <ClientExample message="Builder implements the app, validates it and reports progress in the conversation. You can continue the same saved session if work is interrupted." />
      );
    case "review":
      return (
        <ClientExample message="Review the completed work, its validation and any remaining issues in the conversation. Ask for revisions as needed." />
      );
    case "delivery":
      return (
        <ClientExample message="Requested external changes require their own concrete approval. This example updates a draft on GitHub; the actual delivery depends on the request.">
          <Request request={deliveryApproval} />
        </ClientExample>
      );
    case "done":
      return (
        <ClientExample message="Builder reports the outcome and any remaining action in the conversation. Open the resulting app or reviewed changes using the links supplied for your session." />
      );
    default:
      return null;
  }
}

const meta = {
  component: Journey,
  parameters: { layout: "fullscreen" },
  title: "Journey/Start to finish",
} satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Step01DescribeTheApp: Story = {
  args: { step: "brief" },
  name: "01 · Describe the app",
};
export const Step02SignIn: Story = {
  args: { step: "signin" },
  name: "02 · Sign in or create an account",
};
export const Step02SignUp: Story = {
  args: { step: "signup" },
  name: "02a · Create an account (alternative)",
};
export const Step03WorkspaceSetup: Story = {
  args: { step: "workspace" },
  name: "03 · Workspace setup",
};
export const Step04Configure: Story = {
  args: { step: "configure" },
  name: "04 · Configure the app",
  parameters: { authSession: storybookAuthenticatedSession },
};
export const Step05Handoff: Story = {
  args: { step: "handoff" },
  name: "05 · Continue in your client",
  parameters: { authSession: storybookAuthenticatedSession },
  beforeEach: () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) =>
      String(input).includes(`/api/builder/handoffs/${handoff.handoffId}`)
        ? Response.json(handoff)
        : originalFetch(input, init);
    return () => {
      globalThis.fetch = originalFetch;
    };
  },
};
export const Step06Connect: Story = {
  args: { step: "connect" },
  name: "06 · Connect access if needed",
};
export const Step07Questions: Story = {
  args: { step: "questions" },
  name: "07 · Answer product questions",
};
export const Step08Prototype: Story = {
  args: { step: "prototype" },
  name: "08 · Review the proposal",
};
export const Step09Approve: Story = { args: { step: "approve" }, name: "09 · Approve the build" };
export const Step10Building: Story = {
  args: { step: "building" },
  name: "10 · Build and validate",
};
export const Step11Review: Story = { args: { step: "review" }, name: "11 · Review and revise" };
export const Step12Delivery: Story = {
  args: { step: "delivery" },
  name: "12 · Approve requested delivery",
};
export const Step13Done: Story = { args: { step: "done" }, name: "13 · Use the result" };
