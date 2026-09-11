import type { EveSessionResult, PublicInputRequest } from "@/lib/mcp/contracts";

export const choiceRequest: PublicInputRequest = {
  allowFreeform: false,
  description: "Select where you want to continue building.",
  kind: "question",
  options: [
    { id: "codex", label: "ChatGPT / Codex" },
    { id: "cursor", label: "Cursor" },
  ],
  requestId: "build-client",
  title: "Choose a build client",
};

export const semanticChoiceRequest: PublicInputRequest = {
  ...choiceRequest,
  presentation: { control: "choice", section: "build-with" },
};

export const repositoryScopeRequest: PublicInputRequest = {
  allowFreeform: false,
  description:
    "Choose the account that owns the repository you want Autograph to use.",
  kind: "question",
  options: [
    { id: "123", label: "withAutograph (Organization)" },
    { id: "456", label: "jasonmorganson (User)" },
  ],
  presentation: { control: "choice", section: "store-in" },
  requestId: "github-installation-scope",
  title: "Which GitHub account should Autograph use?",
};

export const freeformRequest: PublicInputRequest = {
  allowFreeform: true,
  description: "Describe the primary users.",
  kind: "question",
  requestId: "audience",
  title: "Who will use this app?",
};

export const approvalRequest: PublicInputRequest = {
  allowFreeform: false,
  description: "Confirm that Autograph can continue with the proposed plan.",
  kind: "approval",
  presentation: { control: "approval", section: "connections" },
  requestId: "approve-plan",
  title: "Approve this plan",
};

export const authorizationRequest: PublicInputRequest = {
  allowFreeform: false,
  authorization: {
    displayName: "GitHub",
    instructions: "Choose the repositories Autograph may access.",
    repositoryAccess: {
      action: "update",
      provider: "github",
      repository: {
        fullName: "withAutograph/app-builder-dogfood",
        name: "app-builder-dogfood",
        owner: "withAutograph",
      },
      scopes: [
        {
          installationId: "123",
          accountLogin: "withAutograph",
          accountType: "Organization",
        },
      ],
    },
    url: "https://builder.example.test/github/installations?continuation=opaque",
  },
  description: "Authorize repository access.",
  kind: "authorization",
  presentation: { control: "provider", section: "store-in" },
  requestId: "connect-github",
  title: "Connect GitHub",
};

export function sessionResult(
  inputRequests: PublicInputRequest[]
): EveSessionResult {
  return {
    cursor: 4,
    events: [],
    inputRequests,
    sessionId: "session-story",
    status: "input_required",
  };
}
