import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readReference } from "./reference";

describe("readReference", () => {
  it("keeps public export subpaths separate and resolves selected tsconfig aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "arrusted-reference-"));
    const core = join(root, "core");
    await mkdir(core, { recursive: true });
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: { "@autograph/components": ["./core/components.tsx"] },
        },
      }),
    );
    await writeFile(
      join(core, "components.tsx"),
      `export function Button(_props: { variant?: "primary" | "secondary" }) { return null; }`,
    );
    const packageRoot = join(root, "packages", "compositions");
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@autograph/compositions",
        exports: { ".": "./src/index.ts", "./table": "./src/table.ts" },
      }),
    );
    await writeFile(
      join(packageRoot, "src/index.ts"),
      `export const Overview = () => null;`,
    );
    await writeFile(
      join(packageRoot, "src/table.ts"),
      `export const DataTable = () => null;`,
    );

    const reference = await readReference(root);
    expect(
      reference.modules["@autograph/components"].exports.Button.props?.variant
        .values,
    ).toEqual(["primary", "secondary"]);
    expect(
      reference.modules["@autograph/compositions"].exports.Overview,
    ).toBeDefined();
    expect(
      reference.modules["@autograph/compositions/table"].exports.DataTable,
    ).toBeDefined();
  });

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
      label: { required: true, primitiveKinds: ["string"] },
    });
    expect(reference.modules["@autograph/components"].exports.helper).toEqual(
      {},
    );
  });
});
