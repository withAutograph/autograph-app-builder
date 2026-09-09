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
          content: `import { PageHeader } from "@autograph/components"; export function Page() { return <><PageHeader title="ready" /><PageHeader title={"ready"} /><PageHeader title={"invalid"} /></>; }`,
        },
      ],
    });
    expect(result.attributes.map((attribute) => attribute.verdict)).toEqual([
      "conforming",
      "conforming",
      "unassessed",
    ]);
  });

  it("checks concrete JSX nodes against recursive public slots without crediting callbacks or unknowns", async () => {
    const root = await mkdtemp(join(tmpdir(), "arrusted-reference-"));
    await mkdir(join(root, "core"), { recursive: true });
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          jsx: "preserve",
          paths: { "@autograph/components": ["./core/components.tsx"] },
        },
      }),
    );
    await writeFile(
      join(root, "core", "components.tsx"),
      `export type Slot = string | JSX.Element | { readonly children?: Slot };
       export function Card(_props: { tag?: Slot; invalid?: string; onSelect: () => void; loose?: any }) { return null; }`,
    );
    const result = checkJsxAttributes({
      arrustedRoot: root,
      files: [
        {
          path: "app/page.tsx",
          content: `import { Card } from "@autograph/components";
            declare global { namespace JSX { interface Element { readonly kind: "jsx" } interface IntrinsicElements { span: {} } } }
            declare const uncertain: any;
            export function Page() { return <><Card tag={<span />} onSelect={() => undefined} loose={uncertain} /><Card invalid={<span />} onSelect={uncertain} /><Card tag={uncertain} onSelect={() => undefined} /></>; }`,
        },
      ],
    });
    expect(result.attributes.map((attribute) => attribute.verdict)).toEqual([
      "conforming",
      "unassessed",
      "unassessed",
      "nonconforming",
      "unassessed",
      "unassessed",
      "unassessed",
    ]);
  });

  it("checks finite object literals and empty arrays against recursive props", async () => {
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
      `type Section = { title: string; sections: Section[] };
       export function RecordDetailPanel(_props: { sections: Section[]; detail: { mode: "compact" | "full"; sections: Section[] } }) { return null; }`,
    );
    const result = checkJsxAttributes({
      arrustedRoot: root,
      files: [
        {
          path: "app/page.tsx",
          content: `import { RecordDetailPanel } from "@autograph/compositions"; export function Page() { return <><RecordDetailPanel sections={[]} detail={{ mode: "compact", sections: [] }} /><RecordDetailPanel sections={[]} detail={{ mode: "wide", sections: [] }} /><RecordDetailPanel sections={[]} detail={{ sections: [] }} /></>; }`,
        },
      ],
    });
    expect(result.attributes.map((attribute) => attribute.verdict)).toEqual([
      "conforming",
      "conforming",
      "conforming",
      "nonconforming",
      "conforming",
      "nonconforming",
    ]);
    expect(result.attributes[3].reason).toContain("wide");
    expect(result.attributes[5].reason).toContain("not assignable");
  });

  it("leaves tuple cardinality to TypeScript and admits finite index entries", async () => {
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
      `type Section = { title: string; sections: Section[] };
       export function Tuples(_props: { required: [Section]; optional: [Section?]; rest: [Section, ...Section[]] }) { return null; }
       export function Directory(_props: { entries: Record<string, Section> }) { return null; }`,
    );
    const result = checkJsxAttributes({
      arrustedRoot: root,
      files: [
        {
          path: "app/page.tsx",
          content: `import { Tuples, Directory } from "@autograph/compositions"; declare const uncertain: any; export function Page() { return <><Tuples required={[]} optional={[]} rest={[]} /><Tuples required={[{ title: "one", sections: [] }, { title: "two", sections: [] }]} optional={[]} rest={[{ title: "one", sections: [] }]} /><Directory entries={{ west: { title: "West", sections: [] } }} /><Directory entries={{ west: { title: 1, sections: [] } }} /><Directory entries={{ ...uncertain }} /><Directory entries={uncertain} /></>; }`,
        },
      ],
    });
    expect(result.attributes.map((attribute) => attribute.verdict)).toEqual([
      "nonconforming",
      "conforming",
      "nonconforming",
      "unassessed",
      "conforming",
      "unassessed",
      "conforming",
      "nonconforming",
      "unassessed",
      "unassessed",
    ]);
  });

  it("does not let an any-bearing union branch rescue finite evidence", async () => {
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
      `export function Choice(_props: { value: { value: string } | { value: any } }) { return null; }`,
    );
    const result = checkJsxAttributes({
      arrustedRoot: root,
      files: [
        {
          path: "app/page.tsx",
          content: `import { Choice } from "@autograph/components"; export function Page() { return <><Choice value={{ value: "ready" }} /><Choice value={{ value: 123 }} /></>; }`,
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
