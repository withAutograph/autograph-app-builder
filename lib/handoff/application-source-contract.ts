import { z } from "zod";

const runtimeStateOmission = "runtime-state";
const dependencyCacheOmission = "dependency-cache";

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
const sourcePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "An unambiguous repository-relative source path is required",
  );
const sourceOmissionKindSchema = z.enum([
  "credential",
  runtimeStateOmission,
  dependencyCacheOmission,
]);
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
    return runtimeStateOmission;
  }
  if (
    parts.some((part) => ["node_modules", ".turbo", ".cache"].includes(part)) ||
    [".next", "coverage", "dist", "build"].includes(parts[0] ?? "")
  ) {
    return dependencyCacheOmission;
  }
  return undefined;
};
export const applicationSourceFileSchema = z.strictObject({
  path: sourcePath,
  mode: z.enum(["100644", "100755"]),
  sha256: digest,
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const applicationSourceManifestSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("application-source-v1"),
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    displayName: z.string().min(1),
    sourceSessionId: z.string().min(1),
    files: z.array(applicationSourceFileSchema).min(1),
    omissions: z.array(
      z.strictObject({
        path: sourcePath,
        reason: z.enum([
          "credential",
          runtimeStateOmission,
          dependencyCacheOmission,
          "symlink",
          "unsupported",
        ]),
      }),
    ),
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
    if (paths.some((entry) => !entry.startsWith(`apps/${manifest.appId}/`))) {
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
  manifest: applicationSourceManifestSchema,
  files: z.array(z.strictObject({ path: sourcePath, contentBase64: z.string() })),
});
export type ApplicationSourceArtifact = z.infer<typeof applicationSourceArtifactSchema>;
export const sourceCandidateReferenceSchema = z.strictObject({
  kind: z.literal("application-source-candidate-v1"),
  uploadId: z.uuid(),
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  manifestDigest: digest,
});
export type SourceCandidateReference = z.infer<typeof sourceCandidateReferenceSchema>;

export const applicationSourceExportReferenceSchema = z.strictObject({
  kind: z.literal("application-source-export-v1"),
  appId: z.string(),
  sourceSessionId: z.string(),
  manifestDigest: digest,
  downloadPath: z.string().regex(/^\/application-source\/[A-Za-z0-9._:@-]+\/[a-f0-9]{64}$/u),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  omissionCount: z.number().int().nonnegative(),
});
