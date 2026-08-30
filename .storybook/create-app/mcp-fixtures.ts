import type { EveSessionResult, PublicInputRequest } from "@/lib/mcp/contracts";

export const choiceRequest: PublicInputRequest = {
  requestId: "build-client",
  kind: "question",
  title: "Choose a build client",
  description: "Select where you want to continue building.",
  options: [
    { id: "codex", label: "ChatGPT / Codex" },
    { id: "cursor", label: "Cursor" },
  ],
  allowFreeform: false,
};

export const semanticChoiceRequest: PublicInputRequest = {
  ...choiceRequest,
  presentation: { section: "build-with", control: "choice" },
};

export const freeformRequest: PublicInputRequest = {
  requestId: "audience",
  kind: "question",
  title: "Who will use this app?",
  description: "Describe the primary users.",
  allowFreeform: true,
};

export const approvalRequest: PublicInputRequest = {
  requestId: "approve-plan",
  kind: "approval",
  title: "Approve this plan",
  description: "Confirm that Autograph can continue with the proposed plan.",
  allowFreeform: false,
  presentation: { section: "connections", control: "approval" },
};

export const authorizationRequest: PublicInputRequest = {
  requestId: "connect-github",
  kind: "authorization",
  title: "Connect GitHub",
  description: "Authorize repository access.",
  allowFreeform: false,
  presentation: { section: "store-in", control: "provider" },
  authorization: {
    url: "https://github.com/login/device",
    userCode: "ABCD-1234",
    instructions: "Open GitHub and enter this one-time code.",
    displayName: "GitHub",
  },
};

export function sessionResult(
  inputRequests: PublicInputRequest[],
): EveSessionResult {
  return {
    sessionId: "session-story",
    status: "input_required",
    cursor: 4,
    events: [],
    inputRequests,
  };
}
