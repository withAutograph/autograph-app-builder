import { z } from "zod";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const releasePointer =
  /^export \* from "\.\/release\/(?<release>[A-Za-z0-9._-]+)\/data-server";\s*$/u;
const releaseManifestSchema = z.object({
  app: appIdSchema,
  hashes: z.object({ schema: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }),
  schema_version: z.string().min(1),
});
const handoffSchema = z.strictObject({
  appId: appIdSchema,
  coreRoute: z.string().regex(/^\/[a-z][a-z0-9-]*$/u),
  operatorGuide: z.string().startsWith("docs/"),
  roles: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/u)),
  schemaReceiptPath: z.string().startsWith("/").nullable(),
  version: z.literal(1),
});

interface SourceReader {
  readTextFile?: (input: { path: string }) => PromiseLike<string | null>;
}

const readOptionalSource = async (source: SourceReader, path: string): Promise<string | null> => {
  if (source.readTextFile === undefined) {
    return null;
  }
  try {
    return await source.readTextFile({ path });
  } catch {
    return null;
  }
};

const checkedReleaseFromSource = async (input: {
  appId: string;
  appRoot: string;
  pointer: string;
  source: SourceReader;
}) => {
  const match = releasePointer.exec(input.pointer.trim());
  if (match?.groups?.release === undefined) {
    throw new Error("checked release pointer");
  }
  const source = await readOptionalSource(
    input.source,
    `${input.appRoot}/schema/release/${match.groups.release}/release-manifest.json`,
  );
  if (source === null) {
    throw new Error("checked release manifest");
  }
  const manifest = releaseManifestSchema.parse(JSON.parse(source));
  if (manifest.app !== input.appId || manifest.schema_version !== match.groups.release) {
    throw new Error("checked release identity");
  }
  return { artifactHash: manifest.hashes.schema, releaseId: manifest.schema_version };
};

const productionContractFromSource = (metadata: string, appId: string) => {
  const contract = handoffSchema.parse(JSON.parse(metadata));
  if (
    contract.appId !== appId ||
    contract.coreRoute !== `/${appId}` ||
    (contract.schemaReceiptPath !== null && !contract.schemaReceiptPath.startsWith(`/${appId}/`))
  ) {
    throw new Error("Production handoff identity");
  }
  return contract;
};

/** Credential-free handoff derived only from the validated app source. */
export const productionReadinessHandoff = async (input: {
  appId: string;
  repositoryRoot: string;
  source: SourceReader;
}) => {
  const appId = appIdSchema.parse(input.appId);
  const appRoot = `${input.repositoryRoot}/apps/${appId}`;
  const [pointer, metadata, taskConfig] = await Promise.all([
    readOptionalSource(input.source, `${appRoot}/schema/index.ts`),
    readOptionalSource(input.source, `${appRoot}/.config/production-handoff.json`),
    readOptionalSource(input.source, `${input.repositoryRoot}/.config/mise/config.toml`),
  ]);
  const blockers: string[] = [];
  let checkedRelease: { releaseId: string; artifactHash: string } | null = null;
  if (pointer !== null) {
    try {
      checkedRelease = await checkedReleaseFromSource({
        appId,
        appRoot,
        pointer,
        source: input.source,
      });
    } catch {
      blockers.push(
        "The checked release pointer and manifest need review before Production preparation.",
      );
    }
  }
  let contract: z.infer<typeof handoffSchema> | null = null;
  if (metadata !== null) {
    try {
      contract = productionContractFromSource(metadata, appId);
    } catch {
      blockers.push("The app-owned Production handoff contract needs review.");
    }
  }
  const operatorTaskAvailable = taskConfig?.includes('[tasks."app:production"]') === true;
  return {
    appId,
    blockers: [
      ...blockers,
      ...(contract === null
        ? ["App-owned Production roles and core workflow have not been declared."]
        : []),
      ...(checkedRelease === null
        ? ["No checked data release exists for a data-backed Production workflow."]
        : []),
      ...(operatorTaskAvailable
        ? []
        : ["The source repository has no app:production operator task."]),
    ],
    checkedRelease,
    nextSteps: [
      "Review this app source and its Production policy separately from the Builder draft PR.",
      "Name the organization and actors; prepare the checked release with protected operator credentials.",
      "Exercise the protected Preview workflow and denied access paths.",
      "Use native provider activation, then check the public Gateway and semantic read-only Production proof.",
    ],
    operatorGuide: contract?.operatorGuide ?? null,
    operatorTask: operatorTaskAvailable ? "mise run app:production -- plan" : null,
    roles: contract?.roles ?? [],
    route: contract?.coreRoute ?? `/${appId}`,
    schemaReceiptPath: contract?.schemaReceiptPath ?? null,
    status: "operator-review-required" as const,
  };
};
