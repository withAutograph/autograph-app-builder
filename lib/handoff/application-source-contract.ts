import { z } from "zod";

const compareSourcePath = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const applicationPathPrefix = "apps/";
const pathSeparator = "/";
const parentPathSegment = "..";
const runtimeStateKind = "runtime-state";
const dependencyCacheKind = "dependency-cache";
const sourcePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith(pathSeparator) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value
        .split(pathSeparator)
        .every((part) => part !== "" && part !== "." && part !== parentPathSegment),
    "An unambiguous repository-relative source path is required",
  );
const sourceOmissionKindSchema = z.enum(["credential", "runtime-state", "dependency-cache"]);
const credentialPathSegments = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".aws",
  ".ssh",
  ".kube",
  ".auth",
  "credentials.json",
  "cookies.json",
]);
export const applicationSourceOmissionReason = (
  value: string,
): z.infer<typeof sourceOmissionKindSchema> | undefined => {
  const parts = value.split("/").slice(2);
  if (
    parts.some(
      (part) =>
        /^\.env(?:\.|$)/u.test(part) ||
        credentialPathSegments.has(part) ||
        /\.(?:pem|key|p12|pfx)$/iu.test(part),
    )
  ) {
    return "credential";
  }
  if (
    ["test-results", "playwright-report", "blob-report"].includes(parts[0] ?? "") ||
    parts.some((part) =>
      [
        ".git",
        ".vercel",
        ".eve",
        ".artifacts",
        ".scratch",
        ".sandbox",
        "local-native-recovery",
      ].includes(part),
    )
  ) {
    return runtimeStateKind;
  }
  if (
    parts.some((part) => ["node_modules", ".turbo", ".cache"].includes(part)) ||
    [".next", "coverage", "dist", "build"].includes(parts[0] ?? "")
  ) {
    return dependencyCacheKind;
  }
  return undefined;
};
export const applicationSourceFileSchema = z.strictObject({
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mode: z.enum(["100644", "100755"]),
  path: sourcePath,
  sha256: digest,
});
export const applicationSourceManifestSchema = z
  .strictObject({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    displayName: z.string().min(1),
    files: z.array(applicationSourceFileSchema).min(1),
    kind: z.literal("application-source-v1"),
    omissions: z.array(
      z.strictObject({
        path: sourcePath,
        reason: z.enum([
          "credential",
          runtimeStateKind,
          dependencyCacheKind,
          "symlink",
          "unsupported",
        ]),
      }),
    ),
    sourceSessionId: z.string().min(1),
    version: z.literal(1),
  })
  .superRefine((manifest, context) => {
    const paths = [...manifest.files, ...manifest.omissions].map((entry) => entry.path);
    if (new Set(paths.map((entry) => entry.normalize("NFC").toLowerCase())).size !== paths.length) {
      context.addIssue({ code: "custom", message: "Source inventory paths must be unique" });
    }
    if (manifest.files.some((entry) => applicationSourceOmissionReason(entry.path) !== undefined)) {
      context.addIssue({
        code: "custom",
        message:
          "Credentials, runtime state and dependency caches cannot be imported as app source",
      });
    }
    const selectedAppPrefix = `${applicationPathPrefix}${manifest.appId}/`;
    if (paths.some((entry) => !entry.startsWith(selectedAppPrefix))) {
      context.addIssue({
        code: "custom",
        message: "Source inventory must remain inside its selected app",
      });
    }
  })
  .transform((manifest) => ({
    ...manifest,
    files: manifest.files.toSorted((left, right) => compareSourcePath(left.path, right.path)),
    omissions: manifest.omissions.toSorted((left, right) =>
      compareSourcePath(left.path, right.path),
    ),
  }));
export type ApplicationSourceManifest = z.infer<typeof applicationSourceManifestSchema>;
export const applicationSourceArtifactSchema = z.strictObject({
  files: z.array(z.strictObject({ contentBase64: z.string(), path: sourcePath })),
  manifest: applicationSourceManifestSchema,
});
export type ApplicationSourceArtifact = z.infer<typeof applicationSourceArtifactSchema>;
export const sourceCandidateReferenceSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  kind: z.literal("application-source-candidate-v1"),
  manifestDigest: digest,
  uploadId: z.uuid(),
});
export type SourceCandidateReference = z.infer<typeof sourceCandidateReferenceSchema>;

export const applicationSourceExportReferenceSchema = z.strictObject({
  appId: z.string(),
  bytes: z.number().int().nonnegative(),
  downloadPath: z.string().regex(/^\/application-source\/[A-Za-z0-9._:@-]+\/[a-f0-9]{64}$/u),
  fileCount: z.number().int().nonnegative(),
  kind: z.literal("application-source-export-v1"),
  manifestDigest: digest,
  omissionCount: z.number().int().nonnegative(),
  sourceSessionId: z.string(),
});
