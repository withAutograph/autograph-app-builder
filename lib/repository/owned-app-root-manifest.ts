import path from "node:path";
import { z } from "zod";

const manifestSchema = z.record(z.string(), z.json());
const workspacePatternsSchema = z.array(z.string().min(1));
const dependenciesSchema = z.record(z.string(), z.string());
const catalogSchema = z.record(
  z.string(),
  z.string().refine((value) => value.trim().length > 0),
);
type Manifest = z.infer<typeof manifestSchema>;
const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const readManifest = (bytes: string): Manifest => manifestSchema.parse(JSON.parse(bytes));
const readCatalog = (manifest: Manifest): z.infer<typeof catalogSchema> =>
  manifest.catalog === undefined ? {} : catalogSchema.parse(manifest.catalog);

const appCatalogDependencies = (manifest: Manifest) => {
  const dependencies = new Set<string>();
  for (const section of dependencySections) {
    const declared = manifest[section];
    if (declared === undefined) {
      continue;
    }
    for (const [name, version] of Object.entries(dependenciesSchema.parse(declared))) {
      if (version === "catalog:") {
        dependencies.add(name);
      }
    }
  }
  return dependencies;
};

/** Rebuild only the selected app's root registration from the current target base. */
export const planOwnedAppRootManifest = (input: {
  appId: string;
  base: string;
  originalPublished: string;
  appManifest: string;
}): string => {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(input.appId)) {
    throw new Error("Invalid selected app identity.");
  }
  const base = readManifest(input.base);
  const app = readManifest(input.appManifest);
  const workspace = `apps/${input.appId}`;
  const workspaceObject =
    base.workspaces !== undefined && !Array.isArray(base.workspaces)
      ? manifestSchema.parse(base.workspaces)
      : undefined;
  const patterns = workspacePatternsSchema.parse(
    workspaceObject === undefined ? (base.workspaces ?? []) : workspaceObject.packages,
  );
  const excluded = patterns.some(
    (pattern) => pattern.startsWith("!") && path.posix.matchesGlob(workspace, pattern.slice(1)),
  );
  if (excluded) {
    throw new Error("The current repository workspace declarations exclude the selected app.");
  }
  let changed = false;
  if (!patterns.some((pattern) => path.posix.matchesGlob(workspace, pattern))) {
    const packages = [...patterns, workspace];
    base.workspaces = workspaceObject === undefined ? packages : { ...workspaceObject, packages };
    changed = true;
  }

  const catalog = readCatalog(base);
  const missing = [...appCatalogDependencies(app)].filter((name) => !Object.hasOwn(catalog, name));
  if (missing.length > 0) {
    const original = readManifest(input.originalPublished);
    const publishedCatalog = readCatalog(original);
    const additions = missing.map((name): [string, string] => {
      if (!Object.hasOwn(publishedCatalog, name)) {
        throw new Error(`The published root catalog has no value for the app dependency ${name}.`);
      }
      return [name, publishedCatalog[name]];
    });
    base.catalog = Object.fromEntries([...Object.entries(catalog), ...additions]);
    changed = true;
  }
  return changed ? `${JSON.stringify(base, null, 2)}\n` : input.base;
};
