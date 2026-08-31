import { describe, expect, it, vi } from "vitest";

import { templateReadinessAttestationDigest } from "./arrusted-template";

describe("canonical Arrusted template readiness", () => {
  it("binds a successful exact-SHA Template readiness check into the source receipt digest", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        check_runs: [
          {
            id: 123,
            name: "Template readiness",
            status: "completed",
            conclusion: "success",
            started_at: "2026-08-31T16:00:00Z",
            completed_at: "2026-08-31T16:01:00Z",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const digest = await templateReadinessAttestationDigest(
      "a".repeat(40),
      "b".repeat(40),
    );

    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/withAutograph/arrusted-development/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs?per_page=100",
      expect.objectContaining({ redirect: "error" }),
    );
    vi.unstubAllGlobals();
  });

  it("fails closed when the exact SHA has no successful readiness check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({
          check_runs: [
            {
              id: 123,
              name: "Template readiness",
              status: "completed",
              conclusion: "failure",
              started_at: "2026-08-31T16:00:00Z",
              completed_at: "2026-08-31T16:01:00Z",
            },
          ],
        }),
      ),
    );

    await expect(
      templateReadinessAttestationDigest("a".repeat(40), "b".repeat(40)),
    ).rejects.toThrow("no successful template-readiness evidence");
    vi.unstubAllGlobals();
  });
});
