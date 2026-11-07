import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVerifiedActorReadback } from "./hosted-operator-verified-actor-readback";

const hooks = vi.hoisted(() => ({ verify: vi.fn() }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Exercise projection independently from the separately tested live session verifier.
vi.mock("./hosted-operator-normal-actor-runtime-bindings", () => ({
  createNormalActorRuntimeBindings: () => hooks.verify,
}));
const program = {
  actors: [
    { account: "capture-existing", actorKey: "owner", email: "owner@example.test", name: "Owner" },
  ],
  appAccess: [{ actorKey: "owner", organizationId: "org", roles: ["requester"] }],
  appId: "spend-review",
  memberships: [{ actorKey: "owner", organizationId: "org", role: "owner" }],
  organizations: [
    { name: "Organization", organizationId: "org", ownerActorKey: "owner", slug: "org" },
  ],
  origin: "https://apps.example.test",
  version: 1,
};
const input = { plan: { normalActorProgram: program } };
const identity = {
  actorId: "actor",
  actorKey: "owner",
  organizationId: "org",
  roles: ["requester"],
  storageState: "private-file",
};
const projection = {
  files: { "private-file": "secret cookie" },
  identities: { actors: [identity], version: 1 },
  origin: program.origin,
};
// SAFETY: The fixture calls the wrapper with a synthetic verified reader and only the plan field used by projection.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the mocked verifier consumes its synthetic dependencies.
const read = createVerifiedActorReadback({} as never);
// SAFETY: The wrapper reads only the fixture plan after the verifier mock returns.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Synthetic owner context is irrelevant to this projection-only fixture.
const request = input as never;

describe("verified actor diagnostic projection", () => {
  beforeEach(() => vi.resetAllMocks());
  it("exposes only the verified approved identity and never the session or request evidence", async () => {
    hooks.verify.mockResolvedValueOnce(projection);
    const result = await read(request);
    expect(result).toEqual({
      actors: [
        {
          account: "capture-existing",
          actorId: "actor",
          actorKey: "owner",
          appRoles: ["requester"],
          email: "owner@example.test",
          membershipRole: "owner",
          organizationId: "org",
        },
      ],
      requestCorrelation: "not_established",
    });
    expect(JSON.stringify(result)).not.toContain("secret cookie");
    expect(hooks.verify).toHaveBeenCalledWith(request);
  });
  it("refuses an identity whose roles differ from the approved program", async () => {
    hooks.verify.mockResolvedValueOnce({
      ...projection,
      identities: { actors: [{ ...identity, roles: ["reviewer"] }], version: 1 },
    });
    await expect(read(request)).rejects.toMatchObject({ code: "resource_mismatch" });
  });
  it("propagates failed live-session verification rather than inventing identity", async () => {
    const failure = new Error("session expired");
    hooks.verify.mockRejectedValueOnce(failure);
    await expect(read(request)).rejects.toBe(failure);
  });
  it("refuses omitted or duplicate approved memberships", async () => {
    for (const actors of [[], [identity, identity]]) {
      hooks.verify.mockResolvedValueOnce({ ...projection, identities: { actors, version: 1 } });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each independent fixture observes a separate failure.
      await expect(read(request)).rejects.toMatchObject({ code: "resource_mismatch" });
    }
  });
});
