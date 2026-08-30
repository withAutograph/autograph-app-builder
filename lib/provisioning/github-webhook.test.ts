import { createHmac } from "node:crypto";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";

import * as databaseSchema from "../db/schema";
import { createGitHubProvisioningWebhookHandler } from "./github-webhook";

const secret = "github-webhook-secret-that-is-long-enough";

function signedRequest(event: string, body: unknown, signatureSecret = secret) {
  const bytes = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", signatureSecret)
    .update(bytes)
    .digest("hex")}`;
  return new Request("https://builder.example.test/api/github/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": signature,
    },
    body: bytes,
  });
}

function database() {
  const updates: unknown[] = [];
  type FakeDatabase = {
    update(table: unknown): {
      set(): { where(): Promise<undefined> };
    };
    transaction<T>(
      operation: (transaction: FakeDatabase) => Promise<T>,
    ): Promise<T>;
  };
  const value: FakeDatabase = {
    update(table: unknown) {
      updates.push(table);
      return {
        set: () => ({ where: async () => undefined }),
      };
    },
    async transaction<T>(operation: (transaction: FakeDatabase) => Promise<T>) {
      return operation(value);
    },
  };
  return {
    updates,
    value: value as unknown as PostgresJsDatabase<typeof databaseSchema>,
  };
}

describe("GitHub provisioning revocation webhook", () => {
  it("authenticates and deactivates revoked user and installation authority", async () => {
    const store = database();
    const handler = createGitHubProvisioningWebhookHandler({
      database: store.value,
      secret,
      now: () => Date.parse("2026-08-30T12:00:00.000Z"),
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
});
