/* oxlint-disable unicorn/no-useless-undefined, eslint/no-await-in-loop, eslint/require-await -- Void mock results and sequential malformed-readback checks model the real async port. */
import { describe, expect, it, vi } from "vitest";
import { readStandardBuilderPublicOrigin } from "./standard-builder-public-origin";

const setup = () => ({
  assertCurrent: vi.fn<() => Promise<void>>().mockResolvedValue(),
  destination: { installationId: "installation", projectId: "actual-project", teamId: "team" },
  fetch: vi
    .fn()
    .mockResolvedValue(
      Response.json({ domains: [{ name: "actual-public.example", verified: true }] }),
    ),
  readCredential: vi
    .fn<Parameters<typeof readStandardBuilderPublicOrigin>[0]["readCredential"]>()
    .mockResolvedValue({
      binding: {
        active: true,
        displayName: "Team",
        installationId: "installation",
        plan: "pro",
        scopeId: "team",
        scopeType: "team",
        slug: "team",
        updatedAt: new Date("2026-11-01T00:00:00Z"),
      },
      token: "private-test-token",
    }),
});
describe("owned standard public origin", () => {
  it("reads an actual verified production domain under the exact team/project and rechecks ownership", async () => {
    const f = setup();
    expect(await readStandardBuilderPublicOrigin(f)).toBe("https://actual-public.example");
    expect(f.fetch).toHaveBeenCalledWith(
      new URL("https://api.vercel.com/v9/projects/actual-project/domains?teamId=team"),
      expect.objectContaining({ redirect: "error" }),
    );
    expect(f.assertCurrent).toHaveBeenCalledTimes(4);
  });
  it.each([
    [[]],
    [[{ name: "unverified.example", verified: false }]],
    [[{ gitBranch: "main", name: "branch.example", verified: true }]],
    [
      [
        {
          customEnvironmentId: "env_nonproduction",
          name: "custom-environment.example",
          verified: true,
        },
      ],
    ],
    [[{ name: "*.example", verified: true }]],
    [[{ name: "redirect.example", redirect: "elsewhere.example", verified: true }]],
    [
      [
        { name: "one.example", verified: true },
        { name: "two.example", verified: true },
      ],
    ],
  ])("requires a domain choice rather than inventing one for %j", async (domains) => {
    const f = setup();
    f.fetch.mockResolvedValue(Response.json({ domains }));
    await expect(readStandardBuilderPublicOrigin(f)).rejects.toMatchObject({
      code: "builder_public_domain_selection_required",
    });
  });
  it("rejects foreign credentials before provider access", async () => {
    const f = setup();
    const credential = await f.readCredential();
    if (credential === undefined) {
      throw new Error("missing fixture");
    }
    credential.binding.scopeId = "foreign";
    await expect(readStandardBuilderPublicOrigin(f)).rejects.toMatchObject({
      code: "builder_destination_configuration_required",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not acknowledge a domain after destination or membership changes", async () => {
    const f = setup();
    f.assertCurrent.mockResolvedValueOnce().mockRejectedValueOnce(new Error("owner changed"));
    await expect(readStandardBuilderPublicOrigin(f)).rejects.toThrow("owner changed");
  });
  it("rejects partial domain listings, malformed provider payloads and non-domain names without retaining payloads", async () => {
    for (const payload of [
      { domains: [{ name: "one.example", verified: true }], pagination: { next: 5 } },
      { domains: [{ name: "private-token@elsewhere.example/path", verified: true }] },
    ]) {
      const f = setup();
      f.fetch.mockResolvedValue(Response.json(payload));
      await expect(readStandardBuilderPublicOrigin(f)).rejects.toMatchObject({
        code: "builder_destination_configuration_required",
      });
    }
    const f = setup();
    f.fetch.mockResolvedValue(new Response("not-json-private-payload"));
    await expect(readStandardBuilderPublicOrigin(f)).rejects.toThrow(
      "builder_destination_configuration_required",
    );
  });
});

it("accepts an explicit current verified choice among multiple domains and rejects a stale one", async () => {
  const f = setup();
  f.fetch.mockImplementation(async () =>
    Response.json({
      domains: [
        { name: "one.example", verified: true },
        { name: "two.example", verified: true },
      ],
    }),
  );
  expect(
    await readStandardBuilderPublicOrigin({ ...f, selectedPublicOrigin: "https://two.example" }),
  ).toBe("https://two.example");
  await expect(
    readStandardBuilderPublicOrigin({ ...f, selectedPublicOrigin: "https://removed.example" }),
  ).rejects.toMatchObject({ code: "builder_public_domain_selection_required" });
});

it("streams every domain page under current ownership before accepting a selected origin", async () => {
  const f = setup();
  f.fetch
    .mockResolvedValueOnce(
      Response.json({
        domains: [{ name: "first.example", verified: true }],
        pagination: { next: 42 },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        domains: [{ name: "second.example", verified: true }],
        pagination: { next: null },
      }),
    );
  expect(
    await readStandardBuilderPublicOrigin({ ...f, selectedPublicOrigin: "https://second.example" }),
  ).toBe("https://second.example");
  expect(f.fetch).toHaveBeenNthCalledWith(
    2,
    new URL("https://api.vercel.com/v9/projects/actual-project/domains?teamId=team&until=42"),
    expect.any(Object),
  );
});
