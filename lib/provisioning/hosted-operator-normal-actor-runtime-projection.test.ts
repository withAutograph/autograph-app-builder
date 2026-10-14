/* oxlint-disable sonarjs/no-hardcoded-passwords -- Synthetic stored normal-session fixtures only. */
import { describe, expect, it } from "vitest";
import {
  initialNormalActorState,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import { projectNormalActorRuntime } from "./hosted-operator-normal-actor-runtime-projection";

const operationRef = "11111111-1111-4111-8111-111111111111";
const program = () =>
  normalActorProgramSchema.parse({
    version: 1,
    appId: "diverse-app",
    origin: "https://actual-preview.example.test",
    actors: ["owner", "second-owner", "shared", "no-access", "unassigned"].map((actorKey) => ({
      actorKey,
      email: `${actorKey}@example.test`,
      name: actorKey,
      account: "capture-existing",
    })),
    organizations: [
      { organizationId: "actual-first-org", ownerActorKey: "owner", name: "First", slug: "first" },
      {
        organizationId: "actual-second-org",
        ownerActorKey: "second-owner",
        name: "Second",
        slug: "second",
      },
    ],
    memberships: [
      { actorKey: "owner", organizationId: "actual-first-org", role: "owner" },
      { actorKey: "second-owner", organizationId: "actual-second-org", role: "owner" },
      { actorKey: "shared", organizationId: "actual-first-org", role: "member" },
      { actorKey: "shared", organizationId: "actual-second-org", role: "member" },
      { actorKey: "no-access", organizationId: "actual-first-org", role: "member" },
    ],
    appAccess: [
      { actorKey: "owner", organizationId: "actual-first-org", roles: ["reviewer"] },
      { actorKey: "shared", organizationId: "actual-first-org", roles: ["requester"] },
      { actorKey: "shared", organizationId: "actual-second-org", roles: ["auditor"] },
    ],
  });
const completed = () => {
  const approved = program();
  const state = initialNormalActorState(approved, operationRef);
  state.actors = state.actors.map((actor, index) => ({
    ...actor,
    signup: "complete",
    credentials: { password: "private-signup-password-that-must-stay-private" },
    session: {
      reference: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
      actorId: `verified-${actor.actorKey}-id`,
      realmSessionId: `private-realm-${actor.actorKey}`,
      origin: approved.origin,
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    storageState: {
      cookies: [
        {
          name: "normal-auth-session",
          value: `actual-cookie-${actor.actorKey}`,
          domain: "actual-preview.example.test",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [
        {
          origin: approved.origin,
          localStorage: [{ name: "selection", value: `actual-local-${actor.actorKey}` }],
        },
      ],
    },
  }));
  state.organizations = state.organizations.map((organization) => ({
    ...organization,
    status: "complete",
  }));
  state.memberships = state.memberships.map((membership) => ({
    ...membership,
    status: "complete",
    invitationId: "private-invitation",
  }));
  return { program: approved, state, operationRef };
};

describe("actual normal actor runtime projection", () => {
  it("includes actual actors across organizations and without access, with only approved per-membership roles", () => {
    const projection = projectNormalActorRuntime(completed());
    expect(projection.origin).toBe("https://actual-preview.example.test");
    const rows = projection.identities.actors;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorKey: "owner",
          actorId: "verified-owner-id",
          organizationId: "actual-first-org",
          roles: ["reviewer"],
        }),
        expect.objectContaining({
          actorKey: "second-owner",
          organizationId: "actual-second-org",
          roles: [],
        }),
        expect.objectContaining({
          actorKey: "no-access",
          organizationId: "actual-first-org",
          roles: [],
        }),
        expect.objectContaining({ actorKey: "unassigned", organizationId: null, roles: [] }),
      ]),
    );
    const shared = rows.filter((actor) => actor.actorKey === "shared");
    expect(
      shared.map((actor) => ({ organizationId: actor.organizationId, roles: actor.roles })),
    ).toEqual([
      { organizationId: "actual-first-org", roles: ["requester"] },
      { organizationId: "actual-second-org", roles: ["auditor"] },
    ]);
    expect(new Set(shared.map((actor) => actor.storageState)).size).toBe(1);
    expect(rows).toHaveLength(6);
    expect(Object.keys(projection.files)).toHaveLength(5);
  });
  it("retains captured cookie and local-storage bytes without projecting account credentials or private workflow metadata", () => {
    const fixture = completed();
    const projection = projectNormalActorRuntime(fixture);
    for (const actor of fixture.state.actors) {
      const row = projection.identities.actors.find((entry) => entry.actorKey === actor.actorKey);
      expect(projection.files[row?.storageState ?? "missing"]).toBe(
        JSON.stringify(actor.storageState),
      );
    }
    expect(JSON.stringify(projection)).not.toContain("private-signup-password");
    expect(JSON.stringify(projection)).not.toContain("private-realm-");
    expect(JSON.stringify(projection)).not.toContain("private-invitation");
    expect(JSON.stringify(projection)).not.toContain("@example.test");
  });
  it("works for a single actor with no organization, without fixture role or actor-count assumptions", () => {
    const approved = program();
    approved.actors = approved.actors.filter((actor) => actor.actorKey === "unassigned");
    approved.organizations = [];
    approved.memberships = [];
    approved.appAccess = [];
    const fixture = completed();
    const state = initialNormalActorState(approved, operationRef);
    state.actors = fixture.state.actors.filter((actor) => actor.actorKey === "unassigned");
    const projection = projectNormalActorRuntime({ program: approved, state, operationRef });
    expect(projection.identities.actors).toEqual([
      expect.objectContaining({ actorKey: "unassigned", organizationId: null, roles: [] }),
    ]);
  });
  it.each(["actor", "membership", "organization"])(
    "reports incomplete actual %s state with a sanitized error",
    (kind) => {
      const fixture = completed();
      if (kind === "actor") {
        fixture.state.actors = fixture.state.actors.map((actor) =>
          actor.actorKey === "unassigned" ? { actorKey: actor.actorKey, signup: "pending" } : actor,
        );
      }
      if (kind === "membership") {
        fixture.state.memberships = fixture.state.memberships.map((membership) => ({
          ...membership,
          status: "attempted",
        }));
      }
      if (kind === "organization") {
        fixture.state.organizations = fixture.state.organizations.map((organization) => ({
          ...organization,
          status: "attempted",
        }));
      }
      expect(() => projectNormalActorRuntime(fixture)).toThrow(
        "normal_actor_preparation_incomplete",
      );
    },
  );
  it.each(["operation", "digest", "actor", "membership", "origin", "duplicate-identity"])(
    "rejects %s authority mismatch without exposing state",
    (kind) => {
      const fixture = completed();
      if (kind === "operation") {
        fixture.operationRef = "33333333-3333-4333-8333-333333333333";
      }
      if (kind === "digest") {
        fixture.state.programDigest = "f".repeat(64);
      }
      if (kind === "actor") {
        fixture.state.actors = fixture.state.actors.filter(
          (actor) => actor.actorKey !== "unassigned",
        );
      }
      if (kind === "membership") {
        fixture.state.memberships = fixture.state.memberships.map((membership) => ({
          ...membership,
          role: "intruder",
        }));
      }
      if (kind === "origin") {
        fixture.state.actors = fixture.state.actors.map((actor) => ({
          ...actor,
          session: actor.session
            ? { ...actor.session, origin: "https://other.example.test" }
            : undefined,
        }));
      }
      if (kind === "duplicate-identity") {
        fixture.state.actors = fixture.state.actors.map((actor) => ({
          ...actor,
          session: actor.session ? { ...actor.session, actorId: "swapped-identity" } : undefined,
        }));
      }
      expect(() => projectNormalActorRuntime(fixture)).toThrow("normal_actor_program_mismatch");
    },
  );
});
