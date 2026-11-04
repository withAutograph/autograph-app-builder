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
export const applicationSourceOmissionReason = (value: string) => {
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        /^\.env(?:\.|$)/u.test(part) ||
        [".npmrc", ".pypirc", "credentials.json", "cookies.json"].includes(part) ||
        /\.(?:pem|key|p12|pfx)$/iu.test(part),
    )
  ) {
    return "credential";
  }
  if (
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
    return "runtime-state";
  }
  if (
    parts.some((part) =>
      ["node_modules", ".next", ".turbo", ".cache", "coverage", "dist", "build"].includes(part),
    )
  ) {
    return "dependency-cache";
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
          "runtime-state",
          "dependency-cache",
          "symlink",
          "unsupported",
        ]),
      }),
    ),
  })
  .superRefine((manifest, context) => {
    const paths = [...manifest.files, ...manifest.omissions].map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
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
