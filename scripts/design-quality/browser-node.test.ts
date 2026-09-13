import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("loads injectable axe source under the production Node ESM and tsx loader", async () => {
  const browserModule = new URL("browser.ts", import.meta.url).href;
  const script = `
    import { measurePage } from ${JSON.stringify(browserModule)};
    let injected = false;
    await measurePage({
      evaluate: async () => ({}),
      addScriptTag: async ({content}) => {
        if (typeof content !== 'string' || content.length < 1000) throw new Error('Missing axe browser source');
        injected = true;
      }
    });
    if (!injected) throw new Error('Measurement did not inject axe');
    process.stdout.write('axe-source-injected');
  `;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    script,
  ]);
  expect(stdout).toBe("axe-source-injected");
});
