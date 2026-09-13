import { selfReproductionDraft } from "./self-reproduction-draft-fixture";
/* oxlint-disable eslint/require-await -- async fixtures implement Sandbox and browser APIs. */
import { describe, expect, it, vi } from "vitest";
import { sandboxBrowserComparison } from "./self-reproduction-runtime-browser";
import { desktopViewports } from "./self-reproduction-parity";

describe("sandbox diagnostic browser captures", () => {
  it.each(["known", "unknown", "inert"])(
    "captures diagnostics with honest %s fixture status",
    async (shape) => {
      const { script, artifactPaths } = sandboxBrowserComparison();
      const writes: string[] = [];
      let current = "";
      const values = new Map<string, string>();
      const getByRole = (_role: string, options: { name: string }) => ({
        waitFor: async () => {
          if (shape === "unknown") throw new Error("No supported control");
        },
        fill: async (value: string) => {
          if (shape !== "inert") values.set(options.name, value);
        },
        inputValue: async () => values.get(options.name) ?? "initial",
      });
      const page = {
        getByRole,
        goto: vi.fn(async (url: string) => {
          current = url;
          return { status: () => 200 };
        }),
        url: () => current,
        locator: () => ({
          innerText: async () => "Useful documentation content long enough to be readable.",
        }),
        screenshot: vi.fn(async () => {
          if (shape === "known" && current.endsWith("/app")) {
            expect(values.get("App name")).toBe(selfReproductionDraft.appName);
            expect(values.get("What would you like to build?")).toBe(selfReproductionDraft.brief);
          }
        }),
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
      const output = JSON.parse(writes.at(-1) ?? "{}");
      expect(output.outcomes).toHaveLength(desktopViewports.length);
      for (const row of output.outcomes) {
        expect(row.fixture).toMatchObject({
          authentication: "unassessed",
          durability: "unassessed",
          matched: shape === "known",
          status: shape === "known" ? "prepared" : "unassessed",
        });
      }
      expect(
        output.outcomes.every(
          (row: { documentation: { returned: boolean } }) => row.documentation.returned,
        ),
      ).toBe(true);
      expect(page.screenshot).toHaveBeenCalledTimes(artifactPaths.length);
      expect(artifactPaths.every((path) => /\/(?:root|documentation)\.png$/u.test(path))).toBe(
        true,
      );
    },
  );
});
