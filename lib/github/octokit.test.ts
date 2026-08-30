import { describe, expect, it, vi } from "vitest";

import { createGuardedGitHubFetch } from "./octokit";

describe("guarded Octokit GitHub transport", () => {
  it("allows only fixed GitHub origins and forces redirects off", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true }),
    );
    const guarded = createGuardedGitHubFetch(request);

    await expect(guarded("https://example.invalid/user")).rejects.toThrow(
      "github-origin-invalid",
    );
    await expect(
      guarded("https://api.github.com/user"),
    ).resolves.toBeInstanceOf(Response);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("rejects declared and streamed responses above the shared bound", async () => {
    const declared = createGuardedGitHubFetch(
      vi.fn<typeof fetch>(async () =>
        Response.json(
          { private: "provider-body" },
          { headers: { "content-length": String(2 * 1024 * 1024 + 1) } },
        ),
      ),
    );
    await expect(declared("https://api.github.com/user")).rejects.toThrow(
      "github-response-too-large",
    );

    const streamed = createGuardedGitHubFetch(
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(2 * 1024 * 1024));
                controller.enqueue(new Uint8Array(1));
                controller.close();
              },
            }),
          ),
      ),
    );
    await expect(streamed("https://api.github.com/user")).rejects.toThrow(
      "github-response-too-large",
    );
  });
});
