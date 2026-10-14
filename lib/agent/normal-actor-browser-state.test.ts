/* oxlint-disable sonarjs/no-hardcoded-passwords -- Synthetic captured-session test data. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalActorBrowserFiles } from "./normal-actor-browser-state";

const manifestSchema = z.object({
  actors: z.array(
    z.object({
      actorId: z.string(),
      organizationId: z.string().nullable(),
      storageState: z.string(),
    }),
  ),
});

const capturedActors = () => ({
  origin: "https://apps-preview.example.test",
  identities: {
    version: 1 as const,
    actors: [
      {
        actorKey: "member",
        actorId: "actual-member-id",
        organizationId: "actual-org-id",
        roles: ["member"],
        storageState: "member.storage.json",
      },
    ],
  },
  files: {
    "member.storage.json": JSON.stringify({
      cookies: [
        {
          name: "session",
          domain: "apps-preview.example.test",
          value: "captured-private-session",
          path: "/",
          secure: true,
        },
      ],
      origins: [
        {
          origin: "https://apps-preview.example.test",
          localStorage: [{ name: "selected-org", value: "captured-private-org" }],
        },
      ],
    }),
  },
});

describe("private normal actor browser state", () => {
  it("preserves a captured parent Domain cookie without treating host-only cookies as parent-scoped", () => {
    const captured = capturedActors();
    const storage = z
      .looseObject({
        cookies: z.array(z.looseObject({ domain: z.string() })),
      })
      .parse(JSON.parse(captured.files["member.storage.json"]));
    storage.cookies[0].domain = ".example.test";
    captured.files["member.storage.json"] = JSON.stringify(storage);
    const prepared = normalActorBrowserFiles(captured, "/private-state", captured.origin);
    expect(prepared.files[0]?.content).toBe(captured.files["member.storage.json"]);
    storage.cookies[0].domain = "example.test";
    captured.files["member.storage.json"] = JSON.stringify(storage);
    expect(() => normalActorBrowserFiles(captured, "/private-state", captured.origin)).toThrow(
      "normal_actor_browser_origin_mismatch",
    );
  });
  it("keeps actual captured bytes and maps the identities manifest to private runtime files", () => {
    const captured = capturedActors();
    const prepared = normalActorBrowserFiles(captured, "/private-state", captured.origin);
    expect(prepared.files).toContainEqual({
      path: "/private-state/normal-actors/member.storage.json",
      mode: 0o600,
      content: captured.files["member.storage.json"],
    });
    const manifest = manifestSchema.parse(
      JSON.parse(
        prepared.files.find((file) => file.path === prepared.identitiesPath)?.content ?? "null",
      ),
    );
    expect(manifest.actors[0]).toMatchObject({
      actorId: "actual-member-id",
      organizationId: "actual-org-id",
      storageState: "/private-state/normal-actors/member.storage.json",
    });
    expect(prepared.privateValues.has("captured-private-session")).toBe(true);
    expect(prepared.privateValues.has("captured-private-org")).toBe(true);
  });
  it("retains multiple organization memberships sharing one actor session", () => {
    const captured = capturedActors();
    captured.identities.actors.push({
      ...captured.identities.actors[0],
      organizationId: "second-actual-org",
    });
    const prepared = normalActorBrowserFiles(captured, "/private-state", captured.origin);
    const manifest = manifestSchema.parse(
      JSON.parse(
        prepared.files.find((file) => file.path === prepared.identitiesPath)?.content ?? "null",
      ),
    );
    expect(manifest.actors).toHaveLength(2);
    expect(manifest.actors.map((actor: { storageState: string }) => actor.storageState)).toEqual([
      "/private-state/normal-actors/member.storage.json",
      "/private-state/normal-actors/member.storage.json",
    ]);
    expect(prepared.files.filter((file) => file.path.endsWith("member.storage.json"))).toHaveLength(
      1,
    );
  });
  it("rejects a changed target instead of rewriting session domains", () => {
    expect(() =>
      normalActorBrowserFiles(capturedActors(), "/private-state", "https://other.example.test"),
    ).toThrow("normal_actor_browser_origin_mismatch");
    const captured = capturedActors();
    captured.files["member.storage.json"] = captured.files["member.storage.json"].replaceAll(
      "apps-preview.example.test",
      "other.example.test",
    );
    expect(() => normalActorBrowserFiles(captured, "/private-state", captured.origin)).toThrow(
      "normal_actor_browser_origin_mismatch",
    );
  });
  it("protects the private directory and gives missing or malformed capture errors without private data", () => {
    const captured = capturedActors();
    captured.identities.actors = captured.identities.actors.map((actor) => ({
      ...actor,
      storageState: "../../environment.json",
    }));
    expect(() => normalActorBrowserFiles(captured, "/private-state", captured.origin)).toThrow(
      "normal_actor_browser_state_invalid",
    );
    const missing = capturedActors();
    missing.identities.actors = missing.identities.actors.map((actor) => ({
      ...actor,
      storageState: "missing.storage.json",
    }));
    expect(() => normalActorBrowserFiles(missing, "/private-state", missing.origin)).toThrow(
      "normal_actor_browser_state_unavailable",
    );
    const invalid = capturedActors();
    invalid.files["member.storage.json"] = "private malformed session";
    expect(() => normalActorBrowserFiles(invalid, "/private-state", invalid.origin)).toThrow(
      "normal_actor_browser_state_invalid",
    );
  });
});
