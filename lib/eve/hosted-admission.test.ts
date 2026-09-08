import { describe, expect, it } from "vitest";

import type { HostedPrincipal } from "./hosted-auth";
import {
  createHostedEveSessionService,
  type HostedEveTransport,
} from "./hosted-service";
import { InMemoryHostedEveStore } from "./hosted-store";

function principal(ownerUserId: string): HostedPrincipal {
  return {
    issuer: "https://builder.example.test/api/auth",
    audience: "https://builder.example.test/mcp",
    workspaceId: "workspace_one",
    ownerUserId,
    scopes: [
      "autograph:session",
      "autograph:start",
      "autograph:get",
      "autograph:send",
      "autograph:respond",
      "autograph:cancel",
    ],
  };
}

function service(input: {
  store: InMemoryHostedEveStore;
  ownerUserId: string;
  status?: "working" | "waiting";
}) {
  let sequence = 0;
  const transport: HostedEveTransport = {
    async start() {
      sequence += 1;
      return {
        adapterSessionId: `${input.ownerUserId}_${sequence}`,
        snapshot: { status: input.status ?? "waiting", events: [] },
      };
    },
    async get() {
      throw new Error("not used");
    },
    async send() {
      throw new Error("not used");
    },
    async respond() {
      throw new Error("not used");
    },
    async cancel() {
      throw new Error("not used");
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
  second = "two",
) {
  await hosted.start({ prompt: "Build", clientRequestId: first });
  return hosted.start({ prompt: "Build again", clientRequestId: second });
}

describe("hosted start capacity", () => {
  it("does not impose App Builder start, subject, or workspace quotas", async () => {
    const store = new InMemoryHostedEveStore();
    const firstUser = service({
      store,
      ownerUserId: "user_one",
      status: "working",
    });
    await expect(startTwice(firstUser)).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    await expect(
      service({ store, ownerUserId: "user_two", status: "working" }).start({
        prompt: "Build in the same workspace",
        clientRequestId: "three",
      }),
    ).resolves.toMatchObject({ sessionId: expect.any(String) });
  });
});
