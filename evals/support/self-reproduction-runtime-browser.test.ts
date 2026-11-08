/* oxlint-disable eslint/require-await -- async fixtures implement Sandbox and browser APIs. */
import { compileFunction } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { sandboxBrowserComparison } from "./self-reproduction-runtime-browser";
import { desktopViewports } from "./self-reproduction-parity";

describe("sandbox diagnostic browser captures", () => {
  it("captures every desktop viewport and records real docs return outcomes", async () => {
    const { script, artifactPaths } = sandboxBrowserComparison();
    const writes: string[] = [];
    let current = "";
    const page = {
      goBack: async () => {
        current = "http://127.0.0.1:3000/app";
      },
      goto: vi.fn(async (url: string) => {
        current = url;
        return { status: () => 200 };
      }),
      locator: () => ({
        innerText: async () => "Useful documentation content long enough to be readable.",
      }),
      screenshot: vi.fn(async () => {}),
      url: () => current,
    };
    const close = vi.fn(async () => {});
    const chromium = {
      launch: async () => ({
        close,
        newContext: async () => ({ close, newPage: async () => page }),
      }),
    };
    const body = script.replaceAll(/^import .*;\n/gmu, "");
    const execute = compileFunction(`return (async () => {${body}})()`, [
      "readFile",
      "writeFile",
      "mkdir",
      "dirname",
      "join",
      "chromium",
      "process",
    ]) as (
      readFile: () => Promise<string>,
      writeFile: (path: string, content: string) => Promise<number>,
      mkdir: () => Promise<void>,
      dirname: () => string,
      join: (...parts: string[]) => string,
      browser: typeof chromium,
      process: { argv: string[] },
    ) => Promise<void>;
    await execute(
      async () => JSON.stringify({ baseURL: "http://127.0.0.1:3000/app" }),
      async (_path: string, content: string) => writes.push(content),
      async () => {},
      () => "/comparison",
      (...parts: string[]) => parts.join("/"),
      chromium,
      { argv: ["node", "runner", "input", "output"] },
    );
    const outputText = writes.at(-1);
    if (outputText === undefined || outputText === "") {
      throw new Error("Expected browser comparison output.");
    }
    const output = z
      .object({
        outcomes: z.array(z.object({ documentation: z.object({ returned: z.boolean() }) })),
      })
      .parse(JSON.parse(outputText));
    expect(output.outcomes).toHaveLength(desktopViewports.length);
    expect(output.outcomes.every((row) => row.documentation.returned)).toBe(true);
    expect(page.screenshot).toHaveBeenCalledTimes(artifactPaths.length);
    expect(artifactPaths.every((path) => /\/(?:root|documentation)\.png$/u.test(path))).toBe(true);
  });
});
