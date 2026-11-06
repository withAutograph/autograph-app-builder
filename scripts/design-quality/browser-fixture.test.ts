import { expect, it, vi } from "vitest";
import { capturePreview } from "./browser";
import { mkdtemp } from "node:fs/promises";
import nodePath from "node:path";
import { tmpdir } from "node:os";

it("prepares the authenticated fixture before measurement or screenshots", async () => {
  const output = await mkdtemp(nodePath.join(tmpdir(), "fixture-test-"));
  const preparePage = vi.fn(async () => {
    throw new Error("measurement reached");
  });
  await expect(
    capturePreview({
      output,
      preparePage,
      scenarios: [],
      tokens: {},
      url: "https://localhost:3001",
    }),
  ).rejects.toThrow("measurement reached");
  expect(preparePage).toHaveBeenCalledOnce();
});

it("does not measure or capture an anonymous fallback after fixture failure", async () => {
  const output = await mkdtemp(nodePath.join(tmpdir(), "fixture-test-"));
  await expect(
    capturePreview({
      output,
      preparePage: async () => {
        throw new Error("auth unavailable");
      },
      scenarios: [],
      tokens: {},
      url: "https://localhost:3001",
    }),
  ).rejects.toThrow("auth unavailable");
});
