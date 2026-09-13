/* oxlint-disable eslint/require-await -- async fixtures implement Sandbox and browser APIs. */
import { describe, expect, it, vi } from "vitest";
import { sandboxBrowserComparison } from "./self-reproduction-runtime-browser";
import { desktopViewports } from "./self-reproduction-parity";

describe("sandbox diagnostic browser captures", () => {
  it("captures every desktop viewport and records real docs return outcomes", async () => {
    const { script, artifactPaths } = sandboxBrowserComparison();
    const writes: string[] = [];
    let current = "";
    const page = {
      goto: vi.fn(async (url: string) => {
        current = url;
        return { status: () => 200 };
      }),
      url: () => current,
      locator: () => ({
        innerText: async () => "Useful documentation content long enough to be readable.",
      }),
      screenshot: vi.fn(async () => {}),
      goBack: async () => {
        current = "http://127.0.0.1:3000/app";
      },
    };
    const close = vi.fn(async () => {});
    const chromium = {
      launch: async () => ({
        newContext: async () => ({ newPage: async () => page, close }),
        close,
      }),
    };
    const body = script.replaceAll(/^import .*;\n/gmu, "");
    // oxlint-disable-next-line eslint/no-new-func -- execute the trusted evaluator script against browser fixtures.
    const execute = new Function(
      "readFile",
      "writeFile",
      "mkdir",
      "dirname",
      "join",
      "chromium",
      "process",
      `return (async () => {${body}})()`,
    );
    await execute(
      async () => JSON.stringify({ baseURL: "http://127.0.0.1:3000/app" }),
      async (_path: string, content: string) => writes.push(content),
      async () => {},
      () => "/comparison",
      (...parts: string[]) => parts.join("/"),
      chromium,
      { argv: ["node", "runner", "input", "output"] },
    );
    const output = JSON.parse(writes.at(-1)!);
    expect(output.outcomes).toHaveLength(desktopViewports.length);
    expect(
      output.outcomes.every(
        (row: { documentation: { returned: boolean } }) => row.documentation.returned,
      ),
    ).toBe(true);
    expect(page.screenshot).toHaveBeenCalledTimes(artifactPaths.length);
    expect(artifactPaths.every((path) => /\/(?:root|documentation)\.png$/u.test(path))).toBe(true);
  });
});
