import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ReactNode } from "react";
import { fn } from "storybook/test";

import { authorizationRequest, sessionResult } from "@/.storybook/create-app/mcp-fixtures";
import type { PublicInputRequest } from "@/lib/mcp/contracts";
import { SessionAppView } from "@/lib/mcp/session-app/view";
import "./direct-chat-journey.stories.css";

const buildRequest: PublicInputRequest = {
  allowFreeform: false,
  kind: "approval",
  requestId: "build-vendor-onboarding",
  title: "Build this app?",
};
const deliveryRequest: PublicInputRequest = {
  allowFreeform: false,
  description:
    "Update the existing draft on GitHub in example/vendor-onboarding with the reviewed changes. It will remain a draft for review; this will not merge or deploy the changes.",
  kind: "approval",
  requestId: "update-draft-pr",
  title: "Update the draft on GitHub?",
};
const connectionRequest: PublicInputRequest = {
  ...authorizationRequest,
  authorization: {
    ...authorizationRequest.authorization,
    repositoryAccess: {
      action: "connect",
      provider: "github",
      repository: {
        fullName: "example/vendor-onboarding",
        name: "vendor-onboarding",
        owner: "example",
      },
      scopes: [],
    },
  },
};

type Step =
  | "brief"
  | "direction"
  | "prototype"
  | "approval"
  | "building"
  | "review"
  | "revision"
  | "revised"
  | "delivery"
  | "done"
  | "connect";

function Message({
  author,
  children,
}: {
  author: "You" | "Autograph App Builder";
  children: ReactNode;
}) {
  return (
    <section
      className={`chat-journey-message${author === "You" ? " chat-journey-message--user" : ""}`}
    >
      <strong>{author}</strong>
      <div>{children}</div>
    </section>
  );
}

function Card({ request }: { request: PublicInputRequest }) {
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

function SubmittedCard() {
  return (
    <SessionAppView
      canCallTools
      canOpenLinks
      onOpenLink={fn(async () => {})}
      onRespond={fn(async () => {})}
      result={{ ...sessionResult([]), status: "working" }}
    />
  );
}

function DirectChatJourney({ step }: { step: Step }) {
  const sequence: Step[] = [
    "brief",
    "direction",
    "prototype",
    "approval",
    "building",
    "review",
    "revision",
    "revised",
    "delivery",
    "done",
  ];
  const position = step === "connect" ? 1 : sequence.indexOf(step);
  return (
    <main className="chat-journey">
      <header className="chat-journey-header">
        <strong>Vendor onboarding app</strong>
      </header>
      <div className="chat-journey-transcript" aria-label="Example conversation">
        <Message author="You">
          <p>
            @Autograph App Builder I need an internal vendor-onboarding app. Operations should
            review vendors, and finance should check tax details when needed.
          </p>
        </Message>
        {position >= 1 && (
          <Message author="Autograph App Builder">
            <p>
              I’ll start with a review queue and vendor details, with finance verification when tax
              details need review. I’ll put together an interactive first version for you to
              explore.
            </p>
          </Message>
        )}
        {step === "connect" && (
          <Message author="Autograph App Builder">
            <p>
              Connect GitHub to give Autograph access to the selected repository, then return here.
            </p>
            <Card request={connectionRequest} />
          </Message>
        )}
        {position >= 2 && (
          <Message author="Autograph App Builder">
            <p>
              The prototype is ready to explore in the Browser. It includes a vendor queue, a detail
              view, and the conditional finance review. You can try the flow and tell me what you’d
              change.
            </p>
          </Message>
        )}
        {position >= 3 && (
          <Message author="Autograph App Builder">
            <p>
              I’ll build the app with the reviewed screens and workflows, including sign-in, saved
              vendor records, and the review history.
            </p>
            {step === "approval" ? <Card request={buildRequest} /> : <SubmittedCard />}
          </Message>
        )}
        {position >= 4 && (
          <Message author="Autograph App Builder">
            <p>I’m building the approved app and checking the review workflow.</p>
          </Message>
        )}
        {position >= 5 && (
          <Message author="Autograph App Builder">
            <p>
              The vendor queue, conditional finance review, and decision history are ready for
              review. I’ve checked the workflows and will call out anything that still needs
              attention.
            </p>
          </Message>
        )}
        {position >= 6 && (
          <Message author="You">
            <p>Can you add a filter for vendors waiting on finance?</p>
          </Message>
        )}
        {position >= 7 && (
          <Message author="Autograph App Builder">
            <p>
              I’ve added a finance-review filter to the queue. You can use it to focus on vendors
              waiting for that step.
            </p>
          </Message>
        )}
        {position >= 8 && (
          <>
            <Message author="You">
              <p>Save the reviewed changes to the draft on GitHub.</p>
            </Message>
            <Message author="Autograph App Builder">
              <p>I can update your draft on GitHub with these changes.</p>
              {step === "delivery" ? <Card request={deliveryRequest} /> : null}
            </Message>
          </>
        )}
        {position >= 9 && (
          <Message author="Autograph App Builder">
            <p>
              Your draft on GitHub has been updated with the reviewed changes. It’s ready for your
              review.
            </p>
          </Message>
        )}
      </div>
      <div className="chat-journey-composer">
        <textarea aria-label="Message" placeholder="Ask a follow-up or request a change…" />
        <button type="button" disabled aria-label="Send message">
          ↑
        </button>
      </div>
    </main>
  );
}

const meta = {
  component: DirectChatJourney,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "An example direct chat conversation. Builder request cards use the real components; the surrounding host chat and messages are illustrative. The prototype opens separately in the client Browser and is not included here.",
      },
    },
  },
  title: "Journey/Direct chat",
} satisfies Meta<typeof DirectChatJourney>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Step01Brief: Story = { args: { step: "brief" }, name: "01 · Submit the brief" };
export const Step02Direction: Story = {
  args: { step: "direction" },
  name: "02 · Builder starts the design",
};
export const Step03Prototype: Story = {
  args: { step: "prototype" },
  name: "03 · Review the prototype",
};
export const Step04Approval: Story = { args: { step: "approval" }, name: "04 · Approve the build" };
export const Step05Building: Story = { args: { step: "building" }, name: "05 · Build in progress" };
export const Step06Review: Story = { args: { step: "review" }, name: "06 · Review the result" };
export const Step07Revision: Story = { args: { step: "revision" }, name: "07 · Request a change" };
export const Step08Revised: Story = { args: { step: "revised" }, name: "08 · Review the change" };
export const Step09Delivery: Story = {
  args: { step: "delivery" },
  name: "09 · Approve requested delivery",
};
export const Step10Done: Story = { args: { step: "done" }, name: "10 · Delivery outcome" };
export const OptionalConnection: Story = {
  args: { step: "connect" },
  name: "Optional · Connect GitHub when needed",
};
