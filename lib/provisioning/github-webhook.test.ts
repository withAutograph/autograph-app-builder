import { createHmac } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";

import { createGitHubProvisioningWebhookHandler } from "./github-webhook";
import type {
  hostedGitHubInstallationBindings,
  hostedGitHubInstallations,
  hostedGitHubUserCredentials,
} from "../db/schema";

const secret = "github-webhook-secret-that-is-long-enough";
type WebhookBody =
  | { action: "revoked"; sender: { id: number } }
  | { action: "deleted"; installation: { id: number } };
type WebhookTable =
  | typeof hostedGitHubInstallationBindings
  | typeof hostedGitHubInstallations
  | typeof hostedGitHubUserCredentials;
interface WebhookSchema {
  hostedGitHubInstallationBindings: typeof hostedGitHubInstallationBindings;
  hostedGitHubInstallations: typeof hostedGitHubInstallations;
  hostedGitHubUserCredentials: typeof hostedGitHubUserCredentials;
}

function signedRequest(event: string, body: WebhookBody, signatureSecret: string = secret) {
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

function database() {
  const updates: unknown[] = [];
  const value = drizzle.mock<WebhookSchema>();
  value.update = (table: WebhookTable) => {
    updates.push(table);
    return {
      set: () => ({ where: async () => {} }),
    };
  };
  value.transaction = async (operation) => await operation(value);
  return {
    updates,
    // SAFETY: The handler exercises only these update, set, where, and transaction chains; each is implemented by this controlled fixture.
    value,
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
});
