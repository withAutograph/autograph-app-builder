/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Ordered capture/chunk publication rechecks owner authority at each step and commits completion last. */
import { createHash } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { appDescriptionSchema } from "../repository/app-description";
import type { AppDescription } from "../repository/app-description";
import { GENERATED_RELEASE_MEMBERS } from "./hosted-operator-sandbox-launcher";
import type { GeneratedAppReleaseFiles } from "./hosted-operator-sandbox-launcher";
import {
  operatorArtifactReferenceSchema,
  operatorArtifactUnavailable,
} from "./hosted-operator-artifact-store";
import type {
  OperatorArtifactContext,
  OperatorArtifactStore,
} from "./hosted-operator-artifact-store";

const generatedKind = "generated-release";
const requiredMember = <T>(files: Readonly<Record<string, T>>, name: string): T => {
  const value = files[name];
  if (value === undefined) {
    throw operatorArtifactUnavailable();
  }
  return value;
};
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const appId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const envelopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    appId,
    files: z.record(z.string(), z.string()),
    kind: z.literal(generatedKind),
    manifestSha256: digest,
    releaseId: z.string().min(1),
    schemaSha256: digest,
    version: z.literal(1),
  }),
  z.strictObject({
    appId,
    content: z.string(),
    kind: z.literal("auth-plan"),
    planDigest: digest,
    targetDigest: digest,
    version: z.literal(1),
  }),
]);
const completionSchema = z.strictObject({
  chunkCount: z.number().int().positive(),
  contentBytes: z.number().int().positive(),
  version: z.literal(1),
});
const manifestSchema = z.object({
  app: appId,
  hashes: z.object({ schema: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }),
  schema_version: z.string().min(1),
});
const authFrameSchema = z.object({
  resource: z.object({ database: z.string(), migratorRole: z.string(), runtimeRole: z.string() }),
  schemaPlan: z.object({ planDigest: digest, targetDigest: digest }),
});
const noCredentials = (content: string) => {
  if (
    /postgres(?:ql)?:\/\/[^\s"'<>]+:[^\s"'<>]+@/iu.test(content) ||
    /["'](?:runtimePassword|migratorPassword|databaseUrl|migrationUrl|maintenanceUrl|privateKey|BETTER_AUTH_SECRET|NEON_API_KEY)["']\s*:\s*["'][^"']+["']/u.test(
      content,
    )
  ) {
    throw operatorArtifactUnavailable();
  }
};
const sourcePath = (directory: string, member: string) => {
  if (
    directory.startsWith("/") ||
    directory.includes("\\") ||
    directory.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw operatorArtifactUnavailable();
  }
  return `repository/${directory}/${member}`;
};
export interface OperatorArtifactPublicationDependencies {
  store: OperatorArtifactStore;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
}
/** Storage verifies immutable captured identity. The catalog-pinned worker remains authoritative for compiled release semantics before any SQL effect. */
export const createOperatorArtifactPublication = (
  deps: OperatorArtifactPublicationDependencies,
) => {
  const publish = async (
    context: OperatorArtifactContext,
    envelope: z.infer<typeof envelopeSchema>,
  ) => {
    const parsed = envelopeSchema.parse(envelope);
    if (parsed.appId !== context.target.appId) {
      throw operatorArtifactUnavailable();
    }
    const content = JSON.stringify(parsed);
    noCredentials(content);
    const artifactRef = `_protected-operator/artifacts/${parsed.kind}/${parsed.appId}/${hash(content)}`;
    // ASCII JSON/base64 chunks use the existing write-once store, without copying a live checkout or changing its bytes.
    const encoded = Buffer.from(content, "utf-8").toString("base64");
    const chunks = Array.from({ length: Math.ceil(encoded.length / 65_536) }, (_, index) =>
      encoded.slice(index * 65_536, (index + 1) * 65_536),
    );
    for (const [index, chunk] of chunks.entries()) {
      await deps.assertCurrentOwner(context);
      await deps.store.put(context, { artifactRef, chunkIndex: index + 1, content: chunk });
      await deps.assertCurrentOwner(context);
    }
    await deps.assertCurrentOwner(context);
    await deps.store.put(context, {
      artifactRef,
      chunkIndex: 0,
      content: JSON.stringify({
        chunkCount: chunks.length,
        contentBytes: Buffer.byteLength(content),
        version: 1,
      }),
    });
    await deps.assertCurrentOwner(context);
    return artifactRef;
  };
  const read = async (context: OperatorArtifactContext, artifactRef: string) => {
    operatorArtifactReferenceSchema.parse(artifactRef);
    await deps.assertCurrentOwner(context);
    const completion = await deps.store.read(context, artifactRef, 0);
    if (completion === undefined || completion.length === 0) {
      throw operatorArtifactUnavailable();
    }
    const metadata = completionSchema.parse(JSON.parse(completion));
    let content = "";
    for (let index = 1; index <= metadata.chunkCount; index += 1) {
      await deps.assertCurrentOwner(context);
      const chunk = await deps.store.read(context, artifactRef, index);
      if (chunk === undefined || chunk.length === 0) {
        throw operatorArtifactUnavailable();
      }
      content += chunk;
    }
    const payload = Buffer.from(content, "base64");
    if (payload.toString("base64") !== content) {
      throw operatorArtifactUnavailable();
    }
    content = payload.toString("utf-8");
    if (
      payload.byteLength !== metadata.contentBytes ||
      hash(payload) !== artifactRef.split("/")[4]
    ) {
      throw operatorArtifactUnavailable();
    }
    const envelope = envelopeSchema.parse(JSON.parse(content));
    if (envelope.appId !== context.target.appId || artifactRef.split("/")[2] !== envelope.kind) {
      throw operatorArtifactUnavailable();
    }
    await deps.assertCurrentOwner(context);
    return envelope;
  };
  return {
    async publishAuthPlan(input: {
      context: OperatorArtifactContext;
      content: Buffer;
      planDigest: string;
      targetDigest: string;
    }) {
      try {
        noCredentials(input.content.toString("utf-8"));
        const frame = authFrameSchema.parse(JSON.parse(input.content.toString("utf-8")));
        if (
          frame.schemaPlan.planDigest !== input.planDigest ||
          frame.schemaPlan.targetDigest !== input.targetDigest
        ) {
          throw operatorArtifactUnavailable();
        }
        return await publish(input.context, {
          appId: input.context.target.appId,
          content: input.content.toString("base64"),
          kind: "auth-plan",
          planDigest: input.planDigest,
          targetDigest: input.targetDigest,
          version: 1,
        });
      } catch {
        throw operatorArtifactUnavailable();
      }
    },
    async publishGeneratedRelease(input: {
      context: OperatorArtifactContext;
      description: AppDescription;
      source: Pick<SandboxSession, "readBinaryFile">;
    }) {
      try {
        const description = appDescriptionSchema.parse(input.description);
        if (
          description.app.id !== input.context.target.appId ||
          description.backend.kind !== "generated-postgres"
        ) {
          throw operatorArtifactUnavailable();
        }
        const files: Record<string, string> = {};
        for (const member of GENERATED_RELEASE_MEMBERS) {
          await deps.assertCurrentOwner(input.context);
          const captured = await input.source.readBinaryFile({
            path: sourcePath(description.backend.release.directory, member),
          });
          if (captured === null) {
            throw operatorArtifactUnavailable();
          }
          const bytes = Buffer.from(captured);
          noCredentials(bytes.toString("utf-8"));
          files[member] = bytes.toString("base64");
        }
        const manifestBytes = Buffer.from(requiredMember(files, "release-manifest.json"), "base64");
        const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf-8")));
        if (
          manifest.app !== description.app.id ||
          manifest.schema_version !== description.backend.release.id ||
          manifest.hashes.schema !== description.backend.release.artifactHash
        ) {
          throw operatorArtifactUnavailable();
        }
        const manifestSha256 = hash(manifestBytes);
        const schemaSha256 = manifest.hashes.schema.slice(7);
        const artifactRef = await publish(input.context, {
          appId: description.app.id,
          files,
          kind: generatedKind,
          manifestSha256,
          releaseId: manifest.schema_version,
          schemaSha256,
          version: 1,
        });
        return { artifactRef, manifestSha256, releaseId: manifest.schema_version, schemaSha256 };
      } catch {
        throw operatorArtifactUnavailable();
      }
    },
    async readAuthPlan(
      context: OperatorArtifactContext,
      expected: { artifactRef: string; planDigest: string; targetDigest: string },
    ) {
      try {
        const envelope = await read(context, expected.artifactRef);
        if (envelope.kind !== "auth-plan") {
          throw operatorArtifactUnavailable();
        }
        if (
          envelope.planDigest !== expected.planDigest ||
          envelope.targetDigest !== expected.targetDigest
        ) {
          throw operatorArtifactUnavailable();
        }
        const content = Buffer.from(envelope.content, "base64");
        if (content.toString("base64") !== envelope.content) {
          throw operatorArtifactUnavailable();
        }
        return { artifactRef: expected.artifactRef, content };
      } catch {
        throw operatorArtifactUnavailable();
      }
    },
    async readGeneratedRelease(
      context: OperatorArtifactContext,
      expected: {
        artifactRef: string;
        releaseId: string;
        manifestSha256: string;
        schemaSha256: string;
      },
    ) {
      try {
        const envelope = await read(context, expected.artifactRef);
        if (envelope.kind !== generatedKind) {
          throw operatorArtifactUnavailable();
        }
        const invalid = [
          envelope.releaseId !== expected.releaseId,
          envelope.manifestSha256 !== expected.manifestSha256,
          envelope.schemaSha256 !== expected.schemaSha256,
          Object.keys(envelope.files).length !== GENERATED_RELEASE_MEMBERS.length,
        ];
        if (invalid.some(Boolean)) {
          throw operatorArtifactUnavailable();
        }
        const files = Object.fromEntries(
          GENERATED_RELEASE_MEMBERS.map((member) => {
            const content = envelope.files[member];
            if (!content) {
              throw operatorArtifactUnavailable();
            }
            const bytes = Buffer.from(content, "base64");
            if (bytes.toString("base64") !== content) {
              throw operatorArtifactUnavailable();
            }
            return [member, bytes];
          }),
        );
        if (hash(requiredMember(files, "release-manifest.json")) !== expected.manifestSha256) {
          throw operatorArtifactUnavailable();
        }
        // SAFETY: Exactly every member in GeneratedAppReleaseFiles has just been decoded and checked.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exactly all closed worker release members have been checked above.
        return { artifactRef: expected.artifactRef, files: files as GeneratedAppReleaseFiles };
      } catch {
        throw operatorArtifactUnavailable();
      }
    },
  };
};
