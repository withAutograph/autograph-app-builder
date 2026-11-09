/* oxlint-disable typescript/no-unsafe-type-assertion -- Preserve the existing test fixtures and asserted runtime boundaries. */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { HostedDatabase } from "../db/hosted-postgres";
import { createGitHubProvisioningWebhookHandler } from "./github-webhook";

const secret = "github-webhook-secret-that-is-long-enough";

// oxlint-disable-next-line eslint/func-style, anti-slop/no-unknown-parameters -- Preserve function declaration hoisting and initialization timing. Preserve the existing unknown input contract.
function signedRequest(event: string, body: unknown, signatureSecret = secret) {
  const bytes = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", signatureSecret).update(bytes).digest("hex")}`;
  return new Request("https://builder.example.test/api/github/webhooks", {
    body: bytes,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": signature,
    },
    method: "POST",
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function database() {
  const updates: unknown[] = [];
  interface FakeDatabase {
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
    update: (table: unknown) => {
      set: () => {
        where: () => Promise<undefined>;
      };
    };
    transaction: <T>(operation: (transaction: FakeDatabase) => Promise<T>) => Promise<T>;
  }
  const value: FakeDatabase = {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    async transaction<T>(operation: (transaction: FakeDatabase) => Promise<T>) {
      return await operation(value);
    },
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
    update(table: unknown) {
      updates.push(table);
      return {
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        set: () => ({ where: async () => {} }),
      };
    },
  };
  return {
    updates,
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- The database fixture implements only the transaction and update paths under test.; Preserve the existing type assertion at this boundary.
    value: value as unknown as HostedDatabase,
  };
}

describe("GitHub provisioning revocation webhook", () => {
  it("authenticates and deactivates revoked user and installation authority", async () => {
    const store = database();
    const handler = createGitHubProvisioningWebhookHandler({
      database: store.value,
      now: () => Date.parse("2026-08-30T12:00:00.000Z"),
      secret,
    });
    expect(
      await handler(
        signedRequest("github_app_authorization", {
          action: "revoked",
          sender: { id: 77 },
        }),
      ),
    ).toMatchObject({ status: 202 });
    expect(
      await handler(
        signedRequest("installation", {
          action: "deleted",
          installation: { id: 101 },
        }),
      ),
    ).toMatchObject({ status: 202 });
    expect(store.updates).toHaveLength(3);
  });

  it("rejects an invalid signature without touching durable state", async () => {
    const store = database();
    const handler = createGitHubProvisioningWebhookHandler({
      database: store.value,
      secret,
    });
    const response = await handler(
      signedRequest(
        "github_app_authorization",
        { action: "revoked", sender: { id: 77 } },
        "different-webhook-secret-that-is-long-enough",
      ),
    );
    expect(response.status).toBe(401);
    expect(store.updates).toHaveLength(0);
  });

  it.each([
    { size: 1024 * 1024, status: 202, updates: 1 },
    { size: 1024 * 1024 + 1, status: 401, updates: 0 },
  ])("enforces the byte limit on a signed $size-byte event", async ({ size, status, updates }) => {
    const store = database();
    const handler = createGitHubProvisioningWebhookHandler({ database: store.value, secret });
    const event = { action: "revoked", sender: { id: 77 }, padding: "" };
    event.padding = "x".repeat(size - Buffer.byteLength(JSON.stringify(event)));
    const request = signedRequest("github_app_authorization", event);
    expect(Buffer.byteLength(await request.clone().text())).toBe(size);
    expect(request.headers.get("content-length")).toBeNull();
    const response = await handler(request);
    expect(response.status).toBe(status);
    expect(store.updates).toHaveLength(updates);
  });

  it("propagates a source stream error without updating durable state", async () => {
    const store = database();
    const handler = createGitHubProvisioningWebhookHandler({ database: store.value, secret });
    const failure = new Error("webhook source stream failed");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    const requestInit = { method: "POST", body, duplex: "half" };
    const request = new Request("https://builder.example.test/api/github/webhooks", requestInit);
    await expect(handler(request)).rejects.toBe(failure);
    expect(store.updates).toHaveLength(0);
  });

  it("stops reading an oversized streamed body before processing the event", async () => {
    const store = database();
    const handler = createGitHubProvisioningWebhookHandler({ database: store.value, secret });
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(512 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const requestInit = { method: "POST", body, duplex: "half" };
    const response = await handler(
      new Request("https://builder.example.test/api/github/webhooks", requestInit),
    );
    expect(response.status).toBe(401);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(4);
    expect(store.updates).toHaveLength(0);
  });
});
