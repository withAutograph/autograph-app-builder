import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Autograph App Builder public branding", () => {
  it("brands canonical package and website metadata", async () => {
    const portable = JSON.parse(await readFile(resolve("plugin.json"), "utf8"));
    const packageManifest = JSON.parse(
      await readFile(resolve("package.json"), "utf8"),
    );
    const layout = await readFile(resolve("app/layout.tsx"), "utf8");

    expect(portable.description).toBe(
      "Design and create apps in supported repositories with Autograph App Builder.",
    );
    expect(packageManifest.description).toBe(
      "Autograph App Builder designs and creates apps in supported repositories.",
    );
    expect(layout).toContain(
      "Design, plan, create, and validate supported apps with Autograph App Builder.",
    );
  });

  it("uses product language in public installation and discovery copy", async () => {
    const readme = await readFile(resolve("README.md"), "utf8");
    const installing = await readFile(resolve("docs/installing.md"), "utf8");

    expect(readme).toContain("Autograph App Builder is a durable, portable");
    expect(readme).toContain("## Run Autograph App Builder locally");
    expect(readme).toContain(
      "For a non-interactive smoke test through App Builder itself:",
    );
    expect(installing).toContain(
      "The bundled App Builder skill is fail-closed",
    );
    expect(installing).toContain("if any App Builder tool is unavailable");
  });
});
