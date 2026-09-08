import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkJsxAttributes, readReference } from "./reference";

describe("readReference", () => {
  it("checks finite nested JSX props through selected TypeScript paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "arrusted-reference-"));
    await mkdir(join(root, "core"), { recursive: true });
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: { "@autograph/compositions": ["./core/compositions.tsx"] },
        },
      }),
    );
    await writeFile(
      join(root, "core", "compositions.tsx"),
      `export type TableSpec = { narrowLayout: "compact" | "full"; columns: Array<{ id: string }> }; export function DataTable(_props: { spec: TableSpec }) { return null; } export function Loose(_props: any) { return null; }`,
    );
    const result = checkJsxAttributes({
      arrustedRoot: root,
      files: [
        {
          path: "app/page.tsx",
          content: `import { DataTable, Loose } from "@autograph/compositions"; const compact = true; export function Page() { return <><DataTable spec={{ narrowLayout: compact ? "compact" : "full", columns: [{ id: "vendor" }] }} /><DataTable spec={{ narrowLayout: "compact", columns: [{ id: "vendor" }], unexpected: true }} /><Loose label={"untyped"} /></>; }`,
        },
      ],
    });
    expect(result.limitations).toEqual([]);
    expect(result.attributes.map((attribute) => attribute.verdict)).toEqual([
      "conforming",
      "nonconforming",
      "unassessed",
    ]);
    expect(result.attributes[1].reason).toContain("unexpected");
  });

  it("accepts a static primitive through a reliable branch of a recursive union", async () => {
    const root = await mkdtemp(join(tmpdir(), "arrusted-reference-"));
    await mkdir(join(root, "core"), { recursive: true });
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: { "@autograph/components": ["./core/components.tsx"] },
        },
      }),
    );
    await writeFile(
      join(root, "core", "components.tsx"),
      `type Node = "ready" | "paused" | { children: Node }; export function PageHeader(_props: { title: Node }) { return null; }`,
    );
    const result = checkJsxAttributes({
      arrustedRoot: root,
      files: [
        {
          path: "app/page.tsx",
          content: `import { PageHeader } from "@autograph/components"; export function Page() { return <><PageHeader title={"ready"} /><PageHeader title={"invalid"} /></>; }`,
        },
      ],
    });
    expect(result.attributes.map((attribute) => attribute.verdict)).toEqual([
      "conforming",
      "unassessed",
    ]);
  });

  it("keeps wholly reliable object unions and unresolved expected types distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "arrusted-reference-"));
    await mkdir(join(root, "core"), { recursive: true });
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: { "@autograph/components": ["./core/components.tsx"] },
        },
      }),
    );
    await writeFile(
      join(root, "core", "components.tsx"),
      `export function Choice(_props: { spec: { id: string } | null }) { return null; } export function Loose(_props: { value: unknown }) { return null; } export function Variant(_props: { mode: "ready" | "paused" }) { return null; }`,
    );
    const result = checkJsxAttributes({
      arrustedRoot: root,
      files: [
        {
          path: "app/page.tsx",
          content: `import { Choice, Loose, Variant } from "@autograph/components"; export function Page() { return <><Choice spec={{ id: "stock" }} /><Loose value={"untrusted target"} /><Variant mode={"invalid"} /></>; }`,
        },
      ],
    });
    expect(result.attributes.map((attribute) => attribute.verdict)).toEqual([
      "conforming",
      "unassessed",
      "nonconforming",
    ]);
  });

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
