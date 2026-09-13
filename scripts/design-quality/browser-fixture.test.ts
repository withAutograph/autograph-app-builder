/* oxlint-disable eslint/require-await -- Browser fixture methods preserve the asynchronous Playwright contract. */
import { expect, it, vi } from "vitest";
import { capturePreview } from "./browser";

const browser = vi.hoisted(() => {
  const page = {
    evaluate: vi.fn(() => Promise.reject(new Error("measurement reached"))),
    goto: vi.fn(() => Promise.resolve({ ok: () => true })),
    screenshot: vi.fn(),
  };
  const close = vi.fn(() => Promise.resolve());
  return { close, page };
});
vi.mock("playwright", () => ({
  chromium: {
    launch: async () => ({
      close: browser.close,
      newContext: async () => ({
        addInitScript: vi.fn(),
        newPage: async () => browser.page,
      }),
    }),
  },
}));

it("prepares the authenticated fixture before measurement or screenshots", async () => {
  browser.page.evaluate.mockClear();
  const preparePage = vi.fn(async () => {
    expect(browser.page.evaluate).not.toHaveBeenCalled();
    expect(browser.page.screenshot).not.toHaveBeenCalled();
  });
  await expect(
    capturePreview({
      output: "/tmp/fixture-test",
      preparePage,
      scenarios: [],
      tokens: {},
      url: "https://localhost:3001",
    }),
  ).rejects.toThrow("measurement reached");
  expect(preparePage).toHaveBeenCalledOnce();
});

it("does not measure or capture an anonymous fallback after fixture failure", async () => {
  browser.page.evaluate.mockClear();
  await expect(
    capturePreview({
      output: "/tmp/fixture-test",
      preparePage: () => Promise.reject(new Error("auth unavailable")),
      scenarios: [],
      tokens: {},
      url: "https://localhost:3001",
    }),
  ).rejects.toThrow("auth unavailable");
  expect(browser.page.evaluate).not.toHaveBeenCalled();
  expect(browser.page.screenshot).not.toHaveBeenCalled();
  expect(browser.close).toHaveBeenCalled();
});
