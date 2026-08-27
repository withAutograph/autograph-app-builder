import { describe, expect, it } from "vitest";

import type { HostedPreviewAdmissionControlBinding } from "../hosted/admission-control";
import type { HostedPrincipal } from "./hosted-auth";
import {
  createHostedEveSessionService,
  HostedAdmissionDeniedError,
  type HostedEveTransport,
} from "./hosted-service";
import { InMemoryHostedEveStore } from "./hosted-store";

const now = Date.parse("2026-08-27T12:00:00.000Z");
const baseBinding: HostedPreviewAdmissionControlBinding = {
  version: 1,
  environment: "preview",
  enforcement: "provider-readback",
  scope: "issuer-audience-workspace-subject",
  startsPerSubjectPerMinute: 10,
  startsPerWorkspacePerMinute: 50,
  maxConcurrentSessionsPerSubject: 2,
  maxActiveSessionsPerWorkspace: 20,
  monthlySpendUsedUsdCents: 0,
  monthlySpendLimitUsdCents: 10_000,
  observedAt: "2026-08-27T11:55:00.000Z",
  expiresAt: "2026-08-27T12:55:00.000Z",
  readbackDigest: `sha256:${"a".repeat(64)}`,
};

function principal(ownerUserId: string): HostedPrincipal {
  return {
    issuer: "https://builder.example.test/api/auth",
    audience: "https://builder.example.test/mcp",
    workspaceId: "workspace_one",
    ownerUserId,
    scopes: [
      "eve:session",
      "eve:start",
      "eve:get",
      "eve:send",
      "eve:respond",
      "eve:cancel",
    ],
  };
}

function service(input: {
  store: InMemoryHostedEveStore;
  ownerUserId: string;
  binding: HostedPreviewAdmissionControlBinding;
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
    admissionControl: input.binding,
    now: () => now,
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

describe("hosted start admission enforcement", () => {
  it("enforces the per-subject start window", async () => {
    const hosted = service({
      store: new InMemoryHostedEveStore(),
      ownerUserId: "user_one",
      binding: { ...baseBinding, startsPerSubjectPerMinute: 1 },
    });
    await expect(startTwice(hosted)).rejects.toBeInstanceOf(
      HostedAdmissionDeniedError,
    );
  });

  it("enforces the shared workspace start window across subjects", async () => {
    const store = new InMemoryHostedEveStore();
    const binding = { ...baseBinding, startsPerWorkspacePerMinute: 1 };
    await service({ store, ownerUserId: "user_one", binding }).start({
      prompt: "Build",
      clientRequestId: "one",
    });
    await expect(
      service({ store, ownerUserId: "user_two", binding }).start({
        prompt: "Build",
        clientRequestId: "two",
      }),
    ).rejects.toBeInstanceOf(HostedAdmissionDeniedError);
  });

  it("enforces concurrent subject and active workspace session ceilings", async () => {
    const concurrent = service({
      store: new InMemoryHostedEveStore(),
      ownerUserId: "user_one",
      binding: { ...baseBinding, maxConcurrentSessionsPerSubject: 1 },
      status: "working",
    });
    await expect(startTwice(concurrent)).rejects.toBeInstanceOf(
      HostedAdmissionDeniedError,
    );

    const store = new InMemoryHostedEveStore();
    const binding = { ...baseBinding, maxActiveSessionsPerWorkspace: 1 };
    await service({ store, ownerUserId: "user_one", binding }).start({
      prompt: "Build",
      clientRequestId: "one",
    });
    await expect(
      service({ store, ownerUserId: "user_two", binding }).start({
        prompt: "Build",
        clientRequestId: "two",
      }),
    ).rejects.toBeInstanceOf(HostedAdmissionDeniedError);
  });
});
