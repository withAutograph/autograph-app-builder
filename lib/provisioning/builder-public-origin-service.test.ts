import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { describe, expect, it, vi } from "vitest";
import {
  createBuilderPublicOriginAction,
  createBuilderPublicOriginService,
} from "./builder-public-origin-service";
import type { BuilderPublicOriginStore } from "./builder-public-origin-store";

const principal = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  ownerUserId: "owner",
  workspaceId: "workspace",
  scopes: ["autograph:session"],
};
const authority = {
  issuer: principal.issuer,
  audience: principal.audience,
  ownerUserId: principal.ownerUserId,
  workspaceId: principal.workspaceId,
};
const scope = {
  appId: "spend",
  projectId: "project",
  teamId: "team",
  installationId: "installation",
  provisioningRequestId: "8b22a6b1-33b9-4bdd-a152-f00e5fa373d9",
  provisioningDigest: "a".repeat(64),
};
const expected = { adapterGeneration: 1, adapterSessionId: "native", cancellationRevision: 0 };
const input = {
  sessionId: "saved",
  scope,
  expected,
  publicOrigin: "https://second.example",
  expectedPublicOrigin: null,
};
const setup = () => {
  let choice: string | undefined;
  const assertCurrent = vi.fn<() => Promise<void>>().mockResolvedValue();
  const readOrigins = vi
    .fn<() => Promise<string[]>>()
    .mockResolvedValue(["https://first.example", "https://second.example"]);
  const store: BuilderPublicOriginStore = {
    read: vi
      .fn<BuilderPublicOriginStore["read"]>()
      .mockImplementation(({ authority: selected }) => {
        hostedTenantAuthoritySchema.parse(selected);
        return Promise.resolve(choice);
      }),
    select: vi.fn<BuilderPublicOriginStore["select"]>().mockImplementation(async (selection) => {
      await selection.assertCurrent();
      if (
        choice !== selection.publicOrigin &&
        (choice ?? null) !== selection.expectedPublicOrigin
      ) {
        throw new Error("builder_public_origin_conflict");
      }
      choice = selection.publicOrigin;
      await selection.assertCurrent();
    }),
  };
  const resolve = vi
    .fn<Parameters<typeof createBuilderPublicOriginService>[0]["resolve"]>()
    .mockResolvedValue({ scope, expected, assertCurrent, readOrigins });
  return {
    service: createBuilderPublicOriginService({ store, resolve }),
    store,
    resolve,
    assertCurrent,
    readOrigins,
  };
};
describe("normal saved-app public origin choice", () => {
  it("lists eligible domains and saves an explicit verified choice without provisioning or transferring an approval", async () => {
    const f = setup();
    expect(await f.service.read(principal, "saved")).toMatchObject({
      expected,
      origins: ["https://first.example", "https://second.example"],
      scope,
      selectedPublicOrigin: null,
    });
    await f.service.select(principal, input);
    expect(await f.store.read({ authority, scope })).toBe(input.publicOrigin);
    expect(f.resolve).toHaveBeenCalledWith(principal, "saved");
    expect(f.store.select).toHaveBeenCalledWith(
      expect.objectContaining({
        authority,
        expectedPublicOrigin: null,
        publicOrigin: input.publicOrigin,
        scope,
      }),
    );
  });
  it.each([
    { ...input, scope: { ...scope, projectId: "foreign" } },
    { ...input, scope: { ...scope, appId: "other-app" } },
    { ...input, scope: { ...scope, provisioningDigest: "b".repeat(64) } },
    { ...input, expected: { ...expected, adapterGeneration: 2 } },
    { ...input, expected: { ...expected, cancellationRevision: 1 } },
    { ...input, publicOrigin: "https://unassigned.example" },
  ])("rejects stale/foreign/unverified intent before metadata writes (%j)", async (selection) => {
    const f = setup();
    await expect(f.service.select(principal, selection)).rejects.toThrow();
    expect(f.store.select).not.toHaveBeenCalled();
  });
  it("uses expected-origin CAS so a stale page cannot replace a concurrent selection", async () => {
    const f = setup();
    await f.service.select(principal, input);
    await expect(
      f.service.select(principal, { ...input, publicOrigin: "https://first.example" }),
    ).rejects.toThrow("builder_public_origin_conflict");
    expect(await f.store.read({ authority, scope })).toBe(input.publicOrigin);
    await f.service.select(principal, {
      ...input,
      publicOrigin: "https://first.example",
      expectedPublicOrigin: input.publicOrigin,
    });
    expect(await f.store.read({ authority, scope })).toBe("https://first.example");
  });
  it("does not save after membership or destination changes during provider readback", async () => {
    const f = setup();
    f.assertCurrent.mockRejectedValueOnce(new Error("membership revoked"));
    await expect(f.service.select(principal, input)).rejects.toThrow("membership revoked");
    expect(f.store.select).not.toHaveBeenCalled();
  });
});

describe("public origin Server Action boundary", () => {
  it("uses current authenticated owner authority and rejects foreign origins before opening data", async () => {
    const select = vi
      .fn<ReturnType<typeof createBuilderPublicOriginService>["select"]>()
      .mockResolvedValue();
    const open = vi.fn().mockResolvedValue({ principal, publicOrigins: { select } });
    const refresh = vi.fn<() => void>();
    const action = createBuilderPublicOriginAction({
      origin: "https://builder.example",
      enabled: () => Promise.resolve(true),
      open,
      refresh,
    });
    expect(await action(input, new Headers({ origin: "https://foreign.example" }))).toHaveProperty(
      "status",
      "error",
    );
    expect(open).not.toHaveBeenCalled();
    expect(await action(input, new Headers({ origin: "https://builder.example" }))).toHaveProperty(
      "status",
      "ready",
    );
    expect(select).toHaveBeenCalledWith(principal, input);
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("keeps interrupted metadata writes visible without retrying or publishing", async () => {
    const select = vi.fn().mockRejectedValue(new Error("metadata acknowledgment interrupted"));
    const action = createBuilderPublicOriginAction({
      origin: "https://builder.example",
      enabled: () => Promise.resolve(true),
      open: () => Promise.resolve({ principal, publicOrigins: { select } }),
      refresh: vi.fn<() => void>(),
    });
    expect(await action(input, new Headers({ origin: "https://builder.example" }))).toHaveProperty(
      "status",
      "error",
    );
    expect(select).toHaveBeenCalledOnce();
  });
});
