import { z } from "zod";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const releasePointer =
  /^export \* from "\.\/release\/(?<release>[A-Za-z0-9._-]+)\/data-server";\s*$/u;
const releaseManifestSchema = z.object({
  app: appIdSchema,
  schema_version: z.string().min(1),
  hashes: z.object({ schema: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }),
});
const handoffSchema = z
  .object({
    version: z.literal(1),
    appId: appIdSchema,
    coreRoute: z.string().regex(/^\/[a-z][a-z0-9-]*$/u),
    schemaReceiptPath: z.string().startsWith("/").nullable(),
    roles: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/u)).max(20),
    operatorGuide: z.string().startsWith("docs/"),
  })
  .strict();

type SourceReader = { readTextFile(input: { path: string }): PromiseLike<string | null> };

/** Credential-free handoff derived only from the validated app source. */
export async function productionReadinessHandoff(input: {
  appId: string;
  repositoryRoot: string;
  source: SourceReader;
}) {
  const appId = appIdSchema.parse(input.appId);
  const appRoot = `${input.repositoryRoot}/apps/${appId}`;
  const [pointer, metadata, taskConfig] = await Promise.all([
    input.source.readTextFile({ path: `${appRoot}/schema/index.ts` }),
    input.source.readTextFile({ path: `${appRoot}/.config/production-handoff.json` }),
    input.source.readTextFile({ path: `${input.repositoryRoot}/.config/mise/config.toml` }),
  ]);
  const blockers: string[] = [];
  let checkedRelease: { releaseId: string; artifactHash: string } | null = null;
  if (pointer !== null) {
    try {
      const match = releasePointer.exec(pointer.trim());
      if (!match?.groups?.release) throw new Error("pointer");
      const source = await input.source.readTextFile({
        path: `${appRoot}/schema/release/${match.groups.release}/release-manifest.json`,
      });
      if (source === null) throw new Error("manifest");
      const manifest = releaseManifestSchema.parse(JSON.parse(source) as unknown);
      if (manifest.app !== appId || manifest.schema_version !== match.groups.release) {
        throw new Error("identity");
      }
      checkedRelease = {
        releaseId: manifest.schema_version,
        artifactHash: manifest.hashes.schema,
      };
    } catch {
      blockers.push(
        "The checked release pointer and manifest need review before Production preparation.",
      );
    }
  }
  let contract: z.infer<typeof handoffSchema> | null = null;
  if (metadata !== null) {
    try {
      const candidate = handoffSchema.parse(JSON.parse(metadata) as unknown);
      if (
        candidate.appId !== appId ||
        candidate.coreRoute !== `/${appId}` ||
        (candidate.schemaReceiptPath && !candidate.schemaReceiptPath.startsWith(`/${appId}/`))
      ) {
        throw new Error("identity");
      }
      contract = candidate;
    } catch {
      blockers.push("The app-owned Production handoff contract needs review.");
    }
  }
  const operatorTaskAvailable = taskConfig?.includes('[tasks."app:production"]') === true;
  return {
    status: "operator-review-required" as const,
    appId,
    route: contract?.coreRoute ?? `/${appId}`,
    checkedRelease,
    roles: contract?.roles ?? [],
    schemaReceiptPath: contract?.schemaReceiptPath ?? null,
    operatorGuide: contract?.operatorGuide ?? null,
    operatorTask: operatorTaskAvailable ? "mise run app:production -- plan" : null,
    blockers: [
      ...blockers,
      ...(contract === null
        ? ["App-owned Production roles and core workflow have not been declared."]
        : []),
      ...(checkedRelease === null
        ? ["No checked data release exists for a data-backed Production workflow."]
        : []),
      ...(!operatorTaskAvailable
        ? ["The source repository has no app:production operator task."]
        : []),
    ],
    nextSteps: [
      "Review this app source and its Production policy separately from the Builder draft PR.",
      "Name the organization and actors; prepare the checked release with protected operator credentials.",
      "Exercise the protected Preview workflow and denied access paths.",
      "Use native provider activation, then check the public Gateway and semantic read-only Production proof.",
    ],
  };
}
