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
    actors: ["owner", "second-owner", "shared", "no-access", "unassigned"].map((actorKey) => ({
      account: "capture-existing",
      actorKey,
      email: `${actorKey}@example.test`,
      name: actorKey,
    })),
    appAccess: [
      { actorKey: "owner", organizationId: "actual-first-org", roles: ["reviewer"] },
      { actorKey: "shared", organizationId: "actual-first-org", roles: ["requester"] },
      { actorKey: "shared", organizationId: "actual-second-org", roles: ["auditor"] },
    ],
    appId: "diverse-app",
    memberships: [
      { actorKey: "owner", organizationId: "actual-first-org", role: "owner" },
      { actorKey: "second-owner", organizationId: "actual-second-org", role: "owner" },
      { actorKey: "shared", organizationId: "actual-first-org", role: "member" },
      { actorKey: "shared", organizationId: "actual-second-org", role: "member" },
      { actorKey: "no-access", organizationId: "actual-first-org", role: "member" },
    ],
    organizations: [
      { name: "First", organizationId: "actual-first-org", ownerActorKey: "owner", slug: "first" },
      {
        name: "Second",
        organizationId: "actual-second-org",
        ownerActorKey: "second-owner",
        slug: "second",
      },
    ],
    origin: "https://actual-preview.example.test",
    version: 1,
  });
const completed = () => {
  const approved = program();
  const state = initialNormalActorState(approved, operationRef);
  state.actors = state.actors.map((actor, index) => ({
    ...actor,
    credentials: { password: "private-signup-password-that-must-stay-private" },
    session: {
      actorId: `verified-${actor.actorKey}-id`,
      expiresAt: "2030-01-01T00:00:00.000Z",
      origin: approved.origin,
      realmSessionId: `private-realm-${actor.actorKey}`,
      reference: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
    },
    signup: "complete",
    storageState: {
      cookies: [
        {
          domain: "actual-preview.example.test",
          expires: -1,
          httpOnly: true,
          name: "normal-auth-session",
          path: "/",
          sameSite: "Lax",
          secure: true,
          value: `actual-cookie-${actor.actorKey}`,
        },
      ],
      origins: [
        {
          localStorage: [{ name: "selection", value: `actual-local-${actor.actorKey}` }],
          origin: approved.origin,
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
    invitationId: "private-invitation",
    status: "complete",
  }));
  state.organizationSessions = approved.memberships.map((membership, index) => ({
    actorKey: membership.actorKey,
    organizationId: membership.organizationId,
    selection: "selected",
    session: {
      activeOrganizationId: membership.organizationId,
      actorId: `verified-${membership.actorKey}-id`,
      expiresAt: "2030-01-01T00:00:00.000Z",
      origin: approved.origin,
      realmSessionId: `private-scoped-${index}`,
      reference: `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`,
    },
    storageState: {
      cookies: [
        {
          domain: "actual-preview.example.test",
          expires: -1,
          httpOnly: true,
          name: "normal-auth-session",
          path: "/",
          sameSite: "Lax",
          secure: true,
          value: `actual-scoped-cookie-${index}`,
        },
      ],
      origins: [
        {
          localStorage: [{ name: "selection", value: `actual-scoped-local-${index}` }],
          origin: approved.origin,
        },
      ],
    },
  }));
  return { operationRef, program: approved, state };
};

describe("actual normal actor runtime projection", () => {
  it("includes actual actors across organizations and without access, with only approved per-membership roles", () => {
    const projection = projectNormalActorRuntime(completed());
    expect(projection.origin).toBe("https://actual-preview.example.test");
    const rows = projection.identities.actors;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: "verified-owner-id",
          actorKey: "owner",
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
    expect(new Set(shared.map((actor) => actor.storageState)).size).toBe(2);
    expect(rows).toHaveLength(6);
    expect(Object.keys(projection.files)).toHaveLength(6);
  });
  it("retains captured cookie and local-storage bytes without projecting account credentials or private workflow metadata", () => {
    const fixture = completed();
    const projection = projectNormalActorRuntime(fixture);
    for (const row of projection.identities.actors) {
      const captured =
        row.organizationId === null
          ? fixture.state.actors.find((actor) => actor.actorKey === row.actorKey)?.storageState
          : fixture.state.organizationSessions?.find(
              (entry) =>
                entry.actorKey === row.actorKey && entry.organizationId === row.organizationId,
            )?.storageState;
      expect(projection.files[row.storageState]).toBe(JSON.stringify(captured));
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
    const projection = projectNormalActorRuntime({ operationRef, program: approved, state });
    expect(projection.identities.actors).toEqual([
      expect.objectContaining({ actorKey: "unassigned", organizationId: null, roles: [] }),
    ]);
  });
  it("requires actual organization sessions instead of projecting base-account cookies", () => {
    const fixture = completed();
    delete fixture.state.organizationSessions;
    expect(() => projectNormalActorRuntime(fixture)).toThrow("auth_identity_required");
  });
  it("requires real selection after candidate sessions exist", () => {
    const fixture = completed();
    fixture.state.organizationSessions = fixture.state.organizationSessions?.map((entry) => ({
      ...entry,
      selection: "pending",
      session: { ...entry.session, activeOrganizationId: null },
    }));
    expect(() => projectNormalActorRuntime(fixture)).toThrow("auth_identity_required");
  });
  it("rejects one real session reused across two organization contexts", () => {
    const fixture = completed();
    fixture.state.organizationSessions = fixture.state.organizationSessions?.map((entry) =>
      entry.actorKey === "shared"
        ? { ...entry, session: { ...entry.session, realmSessionId: "same-real-session" } }
        : entry,
    );
    expect(() => projectNormalActorRuntime(fixture)).toThrow("auth_identity_required");
  });
  it.each(["actor", "origin", "active-organization"])(
    "rejects a scoped session with a changed actual %s",
    (kind) => {
      const fixture = completed();
      fixture.state.organizationSessions = fixture.state.organizationSessions?.map((entry) => {
        const session = { ...entry.session };
        if (kind === "actor") session.actorId = "other-real-user";
        if (kind === "origin") session.origin = "https://other.example.test";
        if (kind === "active-organization") session.activeOrganizationId = "other-real-org";
        return { ...entry, session };
      });
      expect(() => projectNormalActorRuntime(fixture)).toThrow("normal_actor_program_mismatch");
    },
  );
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
