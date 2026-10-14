import { randomUUID } from "node:crypto";
import { z } from "zod";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { describe, expect, it, vi } from "vitest";
import {
  createHostedOperatorNormalAuthClient,
  NormalAuthClientError,
} from "./hosted-operator-normal-auth-client";

const origin = "https://owned-realm.example.com";
const password = `private-normal-${randomUUID()}`;
const approved = async () => {
  await Promise.resolve();
};
const session = (actorId = "actor-one") => ({
  session: {
    id: "session-one",
    userId: actorId,
    expiresAt: "2030-01-01T00:00:00.000Z",
    token: "private-token",
  },
  user: { id: actorId, email: "member@example.com", privateField: "private-response" },
});

describe("normal Auth client", () => {
  it("keeps Max-Age expiry fixed at receipt across repeated reads and resume", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const received = Date.parse("2026-10-14T12:00:00.000Z");
      vi.setSystemTime(received);
      const mocked = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json(
            { user: session().user },
            {
              headers: {
                "set-cookie":
                  "session=private-session; Path=/; Secure; Max-Age=60; Expires=Tue, 01 Jan 2030 00:00:00 GMT",
              },
            },
          ),
        )
        .mockImplementation(async () => await Promise.resolve(Response.json(session())));
      const client = createHostedOperatorNormalAuthClient({
        origin,
        fetch: mocked,
        assertApprovedEffect: approved,
      });
      await client.signIn({ email: "member@example.com", password });
      expect(client.exportStorageState().cookies[0]?.expires).toBe(received / 1000 + 60);
      vi.setSystemTime(received + 30_000);
      await client.getSession();
      const saved = client.exportStorageState();
      expect(saved.cookies[0]?.expires).toBe(received / 1000 + 60);
      const resumed = createHostedOperatorNormalAuthClient({
        origin,
        fetch: mocked,
        storageState: saved,
      });
      vi.setSystemTime(received + 61_000);
      await client.getSession();
      await resumed.getSession();
      expect(new Headers(mocked.mock.calls[2]?.[1]?.headers).has("cookie")).toBe(false);
      expect(new Headers(mocked.mock.calls[3]?.[1]?.headers).has("cookie")).toBe(false);
      expect(client.exportStorageState().cookies).toEqual([]);
      expect(resumed.exportStorageState().cookies).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses real ordinary signup, signin, invitation acceptance and independent membership readback", async () => {
    // Installed Better Auth's memory adapter is a local fixture, not hosted proof or a database grant.
    const auth = betterAuth({
      secret: "normal-auth-local-fixture-long-enough-secret",
      baseURL: origin,
      emailAndPassword: { enabled: true },
      plugins: [organization()],
      logger: { disabled: true },
    });
    const requests: Request[] = [];
    const localFetch: typeof fetch = async (target, init) => {
      const request = new Request(target, init);
      requests.push(request.clone());
      return await auth.handler(request);
    };
    const owner = createHostedOperatorNormalAuthClient({
      origin,
      fetch: localFetch,
      assertApprovedEffect: approved,
    });
    const participant = createHostedOperatorNormalAuthClient({
      origin,
      fetch: localFetch,
      assertApprovedEffect: approved,
    });
    await owner.signUp({ name: "Owner", email: "owner@example.com", password });
    await participant.signUp({ name: "Member", email: "member@example.com", password });
    const actor = await participant.getSession();
    if (!actor) {
      throw new Error("Missing fixture actor");
    }
    expect(actor.email).toBe("member@example.com");
    expect(actor).not.toHaveProperty("token");
    expect(actor).not.toHaveProperty("user");

    // The fixture owner creates an organization using the ordinary endpoint, never an admin API.
    const ownerState = owner.exportStorageState();
    const createOrganization = await auth.handler(
      new Request(`${origin}/api/auth/organization/create`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: ownerState.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
        },
        body: JSON.stringify({ name: "Fixture", slug: "fixture" }),
      }),
    );
    expect(createOrganization.status).toBe(200);
    const created = z.object({ id: z.string() }).parse(await createOrganization.json());
    const invite = await owner.inviteMember({
      organizationId: created.id,
      email: actor.email,
      role: "member",
    });
    expect(await owner.listInvitations({ organizationId: created.id })).toEqual([invite]);
    const accepted = await participant.acceptInvitation({ invitationId: invite.id });
    expect(accepted.member).toMatchObject({
      userId: actor.actorId,
      organizationId: created.id,
      role: "member",
    });
    expect(accepted.invitation.status).toBe("accepted");
    const membership = await participant.listMembers({
      organizationId: created.id,
      userId: actor.actorId,
    });
    expect(membership.total).toBe(1);
    expect(membership.members[0]).toMatchObject({
      userId: actor.actorId,
      user: { id: actor.actorId, email: actor.email },
    });

    const resumed = createHostedOperatorNormalAuthClient({
      origin,
      storageState: participant.exportStorageState(),
      fetch: localFetch,
    });
    expect(await resumed.getSession()).toEqual({ ...actor, activeOrganizationId: created.id });
    const reconciliation = createHostedOperatorNormalAuthClient({
      origin,
      fetch: localFetch,
      assertApprovedEffect: approved,
    });
    expect(await reconciliation.getSession()).toBeNull();
    await reconciliation.signIn({ email: actor.email, password });
    const reconciled = await reconciliation.getSession();
    expect(reconciled?.actorId).toBe(actor.actorId);
    expect(requests.every((request) => new URL(request.url).origin === origin)).toBe(true);
  });

  it("selects independent actual organization sessions through the ordinary endpoint", async () => {
    const auth = betterAuth({
      secret: "normal-auth-local-fixture-long-enough-secret",
      baseURL: origin,
      emailAndPassword: { enabled: true },
      plugins: [organization()],
      logger: { disabled: true },
    });
    const localFetch: typeof fetch = async (target, init) =>
      await auth.handler(new Request(target, init));
    const owner = createHostedOperatorNormalAuthClient({
      origin,
      fetch: localFetch,
      assertApprovedEffect: approved,
    });
    await owner.signUp({ name: "Owner", email: "owner@example.com", password });
    const ids: string[] = [];
    for (const slug of ["first", "second"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Ordinary organization creation changes this single fixture owner session.
      const response = await auth.handler(
        new Request(`${origin}/api/auth/organization/create`, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            cookie: owner
              .exportStorageState()
              .cookies.map((cookie) => `${cookie.name}=${cookie.value}`)
              .join("; "),
          },
          body: JSON.stringify({ name: slug, slug }),
        }),
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- The next ordinary creation follows this actual response.
      ids.push(z.object({ id: z.string() }).parse(await response.json()).id);
    }
    const sessions = await Promise.all(
      ids.map(async (organizationId) => {
        const client = createHostedOperatorNormalAuthClient({
          origin,
          fetch: localFetch,
          assertApprovedEffect: approved,
        });
        await client.signIn({ email: "owner@example.com", password });
        await client.setActiveOrganization({ organizationId });
        return { client, session: await client.getSession() };
      }),
    );
    expect(new Set(sessions.map((entry) => entry.session?.sessionId)).size).toBe(2);
    expect(await sessions[0]?.client.getSession()).toMatchObject({ activeOrganizationId: ids[0] });
    expect(await sessions[1]?.client.getSession()).toMatchObject({ activeOrganizationId: ids[1] });
    const readOnly = createHostedOperatorNormalAuthClient({
      origin,
      fetch: localFetch,
      storageState: sessions[0]?.client.exportStorageState(),
    });
    await expect(
      readOnly.setActiveOrganization({ organizationId: ids[1] ?? "missing" }),
    ).rejects.toMatchObject({ code: "approval_required", operation: "set_active_organization" });
  });

  it("preserves separate cookies, Expires commas, host-only/domain scope, paths and deletion across private resume", async () => {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "host=private-host; Path=/; Secure; HttpOnly; SameSite=Lax; Expires=Tue, 01 Jan 2030 00:00:00 GMT",
    );
    headers.append(
      "set-cookie",
      "parent=private-parent; Domain=example.com; Path=/api/auth; Secure; SameSite=Strict",
    );
    headers.append("set-cookie", "otherpath=private-path; Path=/other; Secure");
    headers.append("set-cookie", "bad=private-bad; Domain=unrelated.com; Path=/; Secure");
    headers.append("set-cookie", "publicsuffix=private-suffix; Domain=com; Path=/; Secure");
    headers.append(
      "set-cookie",
      "__Host-invalid=private-prefix; Domain=example.com; Path=/; Secure",
    );
    const mocked = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ user: session().user }, { headers }))
      .mockResolvedValueOnce(Response.json(session()))
      .mockResolvedValueOnce(
        Response.json(session(), { headers: { "set-cookie": "host=; Max-Age=0; Path=/; Secure" } }),
      )
      .mockResolvedValueOnce(Response.json(session()));
    const client = createHostedOperatorNormalAuthClient({
      origin,
      fetch: mocked,
      assertApprovedEffect: approved,
    });
    await client.signIn({ email: "member@example.com", password });
    const state = client.exportStorageState();
    expect(state.cookies.map((cookie) => cookie.name)).toEqual(["host", "parent", "otherpath"]);
    expect(state.cookies.find((cookie) => cookie.name === "host")).toMatchObject({
      domain: "owned-realm.example.com",
      httpOnly: true,
      sameSite: "Lax",
    });
    expect(state.cookies.find((cookie) => cookie.name === "parent")).toMatchObject({
      domain: ".example.com",
      path: "/api/auth",
      expires: -1,
      sameSite: "Strict",
    });
    const resumed = createHostedOperatorNormalAuthClient({
      origin,
      storageState: state,
      fetch: mocked,
    });
    await resumed.getSession();
    expect(new Headers(mocked.mock.calls[1]?.[1]?.headers).get("cookie")).toBe(
      "parent=private-parent; host=private-host",
    );
    await resumed.getSession();
    expect(resumed.exportStorageState().cookies.map((cookie) => cookie.name)).toEqual([
      "parent",
      "otherpath",
    ]);
    await resumed.getSession();
    expect(new Headers(mocked.mock.calls[3]?.[1]?.headers).get("cookie")).toBe(
      "parent=private-parent",
    );
    expect(state.cookies.map((cookie) => cookie.name)).toContain("host");
  });

  it("requires prior effect approval and only sends fixed same-origin operations with encoded ID queries", async () => {
    const mocked = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ members: [], total: 0 }));
    const client = createHostedOperatorNormalAuthClient({ origin, fetch: mocked });
    await expect(client.signIn({ email: "member@example.com", password })).rejects.toMatchObject({
      code: "approval_required",
    });
    expect(mocked).not.toHaveBeenCalled();
    await client.listMembers({
      organizationId: "https://evil.example/?secret=1",
      userId: "user&private=1",
    });
    const call = mocked.mock.calls.at(0);
    if (!call) {
      throw new Error("Missing fixture request");
    }
    const [target, init] = call;
    const url = new URL(target instanceof Request ? target.url : target);
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe("/api/auth/organization/list-members");
    expect(url.searchParams.get("organizationId")).toBe("https://evil.example/?secret=1");
    expect(url.searchParams.get("filterValue")).toBe("user&private=1");
    expect(init).toMatchObject({ redirect: "error", cache: "no-store", method: "GET" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("origin")).toBe(origin);
  });

  it.each([
    "http://owned-realm.example.com",
    `${origin}/`,
    `${origin}/api/auth`,
    "https://user:private@owned-realm.example.com",
    `${origin}?private=1`,
  ])("rejects non-origin targets before any fetch", (value) => {
    const mocked = vi.fn<typeof fetch>();
    expect(() => createHostedOperatorNormalAuthClient({ origin: value, fetch: mocked })).toThrow(
      NormalAuthClientError,
    );
    expect(mocked).not.toHaveBeenCalled();
  });

  it("rejects cookies copied from another exact host instead of rewriting them", () => {
    expect(() =>
      createHostedOperatorNormalAuthClient({
        origin,
        storageState: {
          cookies: [
            {
              name: "session",
              value: "private-cookie",
              domain: "other.example.com",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ],
          origins: [],
        },
      }),
    ).toThrow("Normal Auth operation failed (invalid_storage_state).");
  });

  it("never includes credentials, cookies, raw errors or server messages in sanitized failures", async () => {
    const mocked = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(`${password} private-cookie ${origin}`))
      .mockResolvedValueOnce(
        Response.json(
          {
            code: "INVALID_EMAIL_OR_PASSWORD",
            message: `${password} private-cookie`,
            response: "private-response",
          },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ code: password, message: "private-response" }, { status: 500 }),
      )
      .mockResolvedValueOnce(Response.json({ privateResponse: password }));
    const client = createHostedOperatorNormalAuthClient({
      origin,
      fetch: mocked,
      assertApprovedEffect: approved,
    });
    for (const expected of [
      { code: "transport_failed" },
      { code: "auth_rejected", httpStatus: 401, authCode: "INVALID_EMAIL_OR_PASSWORD" },
      { code: "auth_rejected", httpStatus: 500, authCode: undefined },
      { code: "invalid_response" },
    ]) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- each scripted response belongs to its preceding request.
        await client.signIn({ email: "member@example.com", password });
        throw new Error("Expected sanitized error");
      } catch (error) {
        expect(error).toBeInstanceOf(NormalAuthClientError);
        expect(error).toMatchObject(expected);
        const serialized = JSON.stringify(error) + String(error);
        for (const value of [
          password,
          "private-cookie",
          "private-response",
          origin,
          "member@example.com",
        ]) {
          expect(serialized).not.toContain(value);
        }
        expect(error).not.toHaveProperty("cause");
      }
    }
  });

  it("rejects oversized bodies, redirects and incoherent sessions without exporting their bytes", async () => {
    const redirected = Response.json(session());
    Object.defineProperty(redirected, "url", {
      value: "https://evil.example/api/auth/get-session",
    });
    const mocked = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ private: "x".repeat(128 * 1024) }))
      .mockResolvedValueOnce(redirected)
      .mockResolvedValueOnce(
        Response.json({ ...session(), user: { id: "other-actor", email: "member@example.com" } }),
      );
    const client = createHostedOperatorNormalAuthClient({ origin, fetch: mocked });
    await expect(client.getSession()).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client.getSession()).rejects.toMatchObject({ code: "transport_failed" });
    await expect(client.getSession()).rejects.toMatchObject({ code: "invalid_response" });
  });
});
