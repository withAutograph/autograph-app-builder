import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readReference } from "./reference";

describe("readReference", () => {
  it("reads exported component props from the selected checkout, not a catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "arrusted-reference-"));
    const packageRoot = join(root, "packages", "components");
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@autograph/components",
        exports: "./src/index.tsx",
      }),
    );
    await writeFile(
      join(packageRoot, "src/index.tsx"),
      `export type ButtonProps = { variant?: "primary" | "secondary"; label: string };
       export function Button(_props: ButtonProps) { return null; }
       export const helper = 1;`,
    );

    const reference = await readReference(root);
    expect(
      reference.modules["@autograph/components"].exports.Button.props,
    ).toEqual({
      variant: { required: false, values: ["primary", "secondary"] },
      label: { required: true },
    });
    expect(reference.modules["@autograph/components"].exports.helper).toEqual(
      {},
    );
  });
});
