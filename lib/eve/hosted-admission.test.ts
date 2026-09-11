import { describe, expect, it } from "vitest";

import type { HostedPrincipal } from "./hosted-auth";
import { createHostedEveSessionService } from "./hosted-service";
import type { HostedEveTransport } from "./hosted-service";
import { InMemoryHostedEveStore } from "./hosted-store";

function principal(ownerUserId: string): HostedPrincipal {
  return {
    audience: "https://builder.example.test/mcp",
    issuer: "https://builder.example.test/api/auth",
    ownerUserId,
    scopes: [
      "autograph:session",
      "autograph:start",
      "autograph:get",
      "autograph:send",
      "autograph:respond",
      "autograph:cancel",
    ],
    workspaceId: "workspace_one",
  };
}

function service(input: {
  store: InMemoryHostedEveStore;
  ownerUserId: string;
  status?: "working" | "waiting";
}) {
  let sequence = 0;
  const transport: HostedEveTransport = {
    async cancel() {
      throw new Error("not used");
    },
    async get() {
      throw new Error("not used");
    },
    async respond() {
      throw new Error("not used");
    },
    async send() {
      throw new Error("not used");
    },
    async start() {
      sequence += 1;
      return {
        adapterSessionId: `${input.ownerUserId}_${sequence}`,
        snapshot: { status: input.status ?? "waiting", events: [] },
      };
    },
  };
  return createHostedEveSessionService({
    principal: principal(input.ownerUserId),
    store: input.store,
    transport,
  });
}

async function startTwice(
  hosted: ReturnType<typeof service>,
  first = "one",
  second = "two"
) {
  await hosted.start({ clientRequestId: first, prompt: "Build" });
  return hosted.start({ clientRequestId: second, prompt: "Build again" });
}

describe("hosted start capacity", () => {
  it("does not impose App Builder start, subject, or workspace quotas", async () => {
    const store = new InMemoryHostedEveStore();
    const firstUser = service({
      ownerUserId: "user_one",
      status: "working",
      store,
    });
    await expect(startTwice(firstUser)).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    await expect(
      service({ ownerUserId: "user_two", status: "working", store }).start({
        clientRequestId: "three",
        prompt: "Build in the same workspace",
      })
    ).resolves.toMatchObject({ sessionId: expect.any(String) });
  });
});
