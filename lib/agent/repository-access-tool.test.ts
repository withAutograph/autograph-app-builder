import { describe, expect, it } from "vitest";
import type {
  ReadyRepositoryAccess,
  RepositoryAccessResult,
} from "../integrations/repository-access";
import type { RepositoryAccessRuntime } from "./deployment-repository-access-runtime";
import { resolveRepositoryAccessForTool } from "./repository-access-tool";

const ready: ReadyRepositoryAccess = {
  accessDigest: "a".repeat(64),
  repository: {
    archived: false,
    defaultBranch: "main",
    headSha: "1".repeat(40),
    headTree: "2".repeat(40),
    name: "stock",
    owner: "acme",
    repositoryId: "20",
    repositoryVariableNames: [],
    visibility: "private",
  },
  scope: {
    accountLogin: "acme",
    accountType: "Organization",
    installationId: "10",
  },
  status: "ready",
};
const reference = { fullName: "acme/stock", name: "stock", owner: "acme" };
const input = { repository: reference.fullName };
interface TokenResult {
  token: string;
}
interface AuthOptions {
  authKey: string;
  displayName: string;
}
interface Provider {
  authorize: () => Promise<{ continuationId: string }>;
  description: string;
  schema?: unknown;
}
interface AuthorizationInput {
  repository: string;
  requestId: string;
  selectedInstallationId?: string;
  sessionId: string;
}
type RepositoryInput = Parameters<RepositoryAccessRuntime["classify"]>[0];
interface AuthorizationCall {
  repository: string;
  requestId: string;
  sessionId: string;
}
const tokenCalls: { provider: Provider; options: AuthOptions }[] = [];
const authCalls: { provider: Provider; options: AuthOptions }[] = [];
const classifyCalls: RepositoryInput[] = [];
const authorizationCalls: AuthorizationCall[] = [];
const ctx = {
  abortSignal: new AbortController().signal,
  callId: "call_one",
  getSandbox: () => {
    throw new Error("Unexpected sandbox access");
  },
  getToken: async (provider: Provider, options: AuthOptions): Promise<TokenResult> => {
    await Promise.resolve();
    tokenCalls.push({ options, provider });
    return { token: "test-token" };
  },
  requireAuth: (provider: Provider, options: AuthOptions): never => {
    authCalls.push({ options, provider });
    throw new Error("Unexpected authorization request");
  },
  session: {
    auth: { current: null, initiator: null },
    id: "ses_one",
    turn: { id: "turn_one", sequence: 0 },
  },
  toolName: "repository-access-tool",
};
const runtime = {
  acquireExistingSourceCredential: async () => {
    await Promise.resolve();
    return { token: "test-token" };
  },
  authorization: (value: AuthorizationInput): Provider => {
    const call: AuthorizationCall = {
      repository: value.repository,
      requestId: value.requestId,
      sessionId: value.sessionId,
    };
    authorizationCalls.push(call);
    return {
      authorize: async () => {
        await Promise.resolve();
        return { continuationId: "continuation_one" };
      },
      description: "Authorize repository access",
    };
  },
  classify: async (value: RepositoryInput): Promise<RepositoryAccessResult> => {
    await Promise.resolve();
    classifyCalls.push(value);
    return ready;
  },
  prepareExistingSource: async () => {
    await Promise.resolve();
    throw new Error("Unexpected source preparation");
  },
  resumeAuthorizedForSession: async () => {
    await Promise.resolve();
    return 0;
  },
} satisfies RepositoryAccessRuntime;

describe("repository access tool continuity", () => {
  it("continues with freshly ready access without any auth request", async () => {
    tokenCalls.length = 0;
    authCalls.length = 0;
    classifyCalls.length = 0;
    authorizationCalls.length = 0;
    expect(await resolveRepositoryAccessForTool(input, ctx, runtime)).toMatchObject({
      kind: "ready",
      receipt: { scope: ready.scope, sessionId: "ses_one" },
    });
    expect(classifyCalls).toHaveLength(1);
    expect(authorizationCalls).toHaveLength(0);
    expect(tokenCalls).toHaveLength(0);
    expect(authCalls).toHaveLength(0);
  });
  it("retries an outage without entering authorization", async () => {
    tokenCalls.length = 0;
    authCalls.length = 0;
    classifyCalls.length = 0;
    authorizationCalls.length = 0;
    const outage: RepositoryAccessResult = {
      repository: reference,
      status: "provider-unavailable",
    };
    runtime.classify = async (value: RepositoryInput): Promise<RepositoryAccessResult> => {
      await Promise.resolve();
      classifyCalls.push(value);
      return outage;
    };
    await expect(resolveRepositoryAccessForTool(input, ctx, runtime)).rejects.toMatchObject({
      reason: "provider_unavailable",
      retryable: true,
    });
    expect(authorizationCalls).toHaveLength(0);
    expect(tokenCalls).toHaveLength(0);
  });
  it("parks missing access in the existing same-session authorization flow and rechecks it", async () => {
    tokenCalls.length = 0;
    authCalls.length = 0;
    classifyCalls.length = 0;
    authorizationCalls.length = 0;
    const authorizationRequired: RepositoryAccessResult = {
      action: "update",
      repository: reference,
      scopes: [],
      status: "authorization-required",
    };
    const outcomes: RepositoryAccessResult[] = [authorizationRequired, ready];
    runtime.classify = async (value: RepositoryInput): Promise<RepositoryAccessResult> => {
      await Promise.resolve();
      classifyCalls.push(value);
      return outcomes.shift() ?? ready;
    };
    expect(await resolveRepositoryAccessForTool(input, ctx, runtime)).toMatchObject({
      kind: "ready",
    });
    expect(authorizationCalls).toEqual([
      {
        repository: reference.fullName,
        requestId: "call_one",
        sessionId: "ses_one",
      },
    ]);
    expect(tokenCalls).toHaveLength(1);
    expect(classifyCalls).toHaveLength(2);
  });
  it("does not record access when a post-authorization read is unavailable", async () => {
    tokenCalls.length = 0;
    authCalls.length = 0;
    classifyCalls.length = 0;
    authorizationCalls.length = 0;
    const authorizationRequired: RepositoryAccessResult = {
      action: "update",
      repository: reference,
      scopes: [],
      status: "authorization-required",
    };
    const outage: RepositoryAccessResult = {
      repository: reference,
      status: "provider-unavailable",
    };
    const outcomes: RepositoryAccessResult[] = [authorizationRequired, outage];
    runtime.classify = async (value: RepositoryInput): Promise<RepositoryAccessResult> => {
      await Promise.resolve();
      classifyCalls.push(value);
      return outcomes.shift() ?? ready;
    };
    await expect(resolveRepositoryAccessForTool(input, ctx, runtime)).rejects.toMatchObject({
      reason: "provider_unavailable",
      retryable: true,
    });
    expect(authCalls).toHaveLength(0);
  });
});
