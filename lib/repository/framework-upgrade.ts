import { createHash } from "node:crypto";
import { rcompare, satisfies, valid } from "semver";
import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";

const stableVersion = z.string().regex(/^\d+\.\d+\.\d+$/u);
export const frameworkVersionsSchema = z.strictObject({
  next: stableVersion,
  react: stableVersion,
  reactDom: stableVersion,
  typesReact: stableVersion,
  typesReactDom: stableVersion,
});
export type FrameworkVersions = z.infer<typeof frameworkVersionsSchema>;
export const frameworkSharedPaths = ["package.json", "bun.lock"] as const;
export const frameworkUpgradeSchema = z.strictObject({
  versions: frameworkVersionsSchema,
  scope: z.literal("workspace"),
  baseline: z.array(
    z.strictObject({
      path: z.enum(frameworkSharedPaths),
      before: z
        .strictObject({
          digest: z.string().regex(/^[0-9a-f]{64}$/u),
          mode: z.string().regex(/^[0-7]{3,4}$/u),
        })
        .optional(),
    }),
  ),
});
export type FrameworkUpgrade = z.infer<typeof frameworkUpgradeSchema>;
class RegistryPackageNotFoundError extends Error {
  override name = "RegistryPackageNotFoundError";
}

const metadataSchema = z.object({
  version: stableVersion,
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

/** Resolve once during planning. Apply and resume use only the stored concrete versions. */
export type FrameworkRegistryFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

export const resolveLatestFrameworkVersions = async (
  fetchMetadata: FrameworkRegistryFetch = fetch,
): Promise<FrameworkVersions> => {
  const read = async (name: string, version = "latest") => {
    const response = await fetchMetadata(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
    );
    if (response.status === 404) {
      throw new RegistryPackageNotFoundError(`No published ${name}@${version}`);
    }
    if (!response.ok) {
      throw new Error(`Could not resolve ${name}: npm returned ${response.status}`);
    }
    return metadataSchema.parse(await response.json());
  };
  const [next, latestReact, latestTypesReact, latestTypesReactDom] = await Promise.all([
    read("next"),
    read("react"),
    read("@types/react"),
    read("@types/react-dom"),
  ]);
  const supports = (metadata: z.infer<typeof metadataSchema>, name: string, version: string) =>
    metadata.peerDependencies?.[name] === undefined ||
    satisfies(version, metadata.peerDependencies[name]);
  const candidates = async (name: string) => {
    const response = await fetchMetadata(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!response.ok) {
      throw new Error(`Could not resolve ${name}: npm returned ${response.status}`);
    }
    const packument = z
      .object({ versions: z.record(z.string(), z.unknown()) })
      .parse(await response.json());
    return Object.entries(packument.versions)
      .filter(([version]) => valid(version) !== null && stableVersion.safeParse(version).success)
      .toSorted(([left], [right]) => rcompare(left, right))
      .map(([, metadata]) => metadataSchema.parse(metadata));
  };
  let react = latestReact;
  let reactDom: z.infer<typeof metadataSchema> | null = null;
  try {
    reactDom = await read("react-dom", react.version);
  } catch (error) {
    if (!(error instanceof RegistryPackageNotFoundError)) {
      throw error;
    }
  }

  if (
    reactDom === null ||
    !supports(next, "react", react.version) ||
    !supports(next, "react-dom", reactDom.version) ||
    !supports(reactDom, "react", react.version)
  ) {
    const [reacts, doms] = await Promise.all([candidates("react"), candidates("react-dom")]);
    const pair = reacts.flatMap((candidate) => {
      const dom = doms.find((value) => value.version === candidate.version);
      if (dom === undefined || !supports(next, "react", candidate.version)) {
        return [];
      }
      if (!supports(next, "react-dom", dom.version) || !supports(dom, "react", candidate.version)) {
        return [];
      }
      return [{ react: candidate, reactDom: dom }];
    })[0];
    if (pair === undefined) {
      throw new Error(`Next.js ${next.version} has no compatible stable React/React DOM pair`);
    }
    ({ react, reactDom } = pair);
  }
  let typesReact = latestTypesReact;
  let typesReactDom = latestTypesReactDom;
  const sameMajor = (version: string) => version.split(".")[0] === react.version.split(".")[0];
  if (
    !sameMajor(typesReact.version) ||
    !sameMajor(typesReactDom.version) ||
    !supports(typesReactDom, "@types/react", typesReact.version)
  ) {
    const [reactTypes, domTypes] = await Promise.all([
      candidates("@types/react"),
      candidates("@types/react-dom"),
    ]);
    const pair = domTypes.flatMap((dom) => {
      if (!sameMajor(dom.version)) {
        return [];
      }
      const types = reactTypes.find(
        (value) => sameMajor(value.version) && supports(dom, "@types/react", value.version),
      );
      return types === undefined ? [] : [{ typesReact: types, typesReactDom: dom }];
    })[0];
    if (pair === undefined) {
      throw new Error(`React ${react.version} has no compatible stable type packages`);
    }
    ({ typesReact, typesReactDom } = pair);
  }
  return frameworkVersionsSchema.parse({
    next: next.version,
    react: react.version,
    reactDom: reactDom.version,
    typesReact: typesReact.version,
    typesReactDom: typesReactDom.version,
  });
};

export const planFrameworkUpgrade = async (
  sandbox: SandboxSession,
  versions: FrameworkVersions,
): Promise<FrameworkUpgrade> => {
  const baseline = await Promise.all(
    frameworkSharedPaths.map(async (path) => {
      const bytes = await sandbox.readBinaryFile({ path: `repository/${path}` });
      const stat =
        bytes === null
          ? undefined
          : await sandbox.run({ command: `stat -c %a /workspace/repository/${path}` });
      return {
        path,
        ...(bytes === null
          ? {}
          : {
              before: {
                digest: createHash("sha256").update(bytes).digest("hex"),
                mode:
                  stat?.exitCode === 0 && /^[0-7]{3,4}$/u.test(stat.stdout.trim())
                    ? stat.stdout.trim()
                    : "644",
              },
            }),
      };
    }),
  );
  return { baseline, scope: "workspace", versions: frameworkVersionsSchema.parse(versions) };
};

export const frameworkUpgradeCommand = (upgrade: FrameworkUpgrade, appId: string): string => {
  const v = frameworkVersionsSchema.parse(upgrade.versions);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(appId)) {
    throw new Error("Invalid framework upgrade app identity");
  }
  return `mise run repository:upgrade-framework -- --next ${v.next} --react ${v.react} --react-dom ${v.reactDom} --types-react ${v.typesReact} --types-react-dom ${v.typesReactDom} --app ${appId}`;
};
