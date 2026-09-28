import { describe, expect, it, vi } from "vitest";

import { createGuardedGitHubFetch } from "./octokit";

describe("guarded Octokit GitHub transport", () => {
  it("allows only fixed GitHub origins and forces redirects off", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const request = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const guarded = createGuardedGitHubFetch(request);

    await expect(guarded("https://example.invalid/user")).rejects.toThrow("github-origin-invalid");
    await expect(guarded("https://api.github.com/user")).resolves.toBeInstanceOf(Response);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("passes large provider response streams through without buffering or Builder caps", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    );
    const guarded = createGuardedGitHubFetch(
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      vi.fn<typeof fetch>(async () => response),
    );
    await expect(guarded("https://api.github.com/user")).resolves.toBe(response);
    const body = await response.arrayBuffer();
    expect(body.byteLength).toBe(2 * 1024 * 1024 + 1);
  });
});
