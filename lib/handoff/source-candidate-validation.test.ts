import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { builderHandoffIntentSchema } from "./contracts";
import { validateApplicationSourceArtifact } from "./application-source-bytes";
import { createOwnedSourceCandidateValidator } from "./source-candidate-validation";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user-one",
  workspaceId: "workspace-one",
};
const content = Buffer.from("source data");
const verified = validateApplicationSourceArtifact({
  files: [{ contentBase64: content.toString("base64"), path: "apps/supplier-spend/README.md" }],
  manifest: {
    appId: "supplier-spend",
    displayName: "Supplier Spend",
    files: [
      {
        bytes: content.length,
        mode: "100644",
        path: "apps/supplier-spend/README.md",
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
    kind: "application-source-v1",
    omissions: [],
    sourceSessionId: "local-source",
    version: 1,
  },
});
const intent = builderHandoffIntentSchema.parse({
  appId: "supplier-spend",
  appName: "Supplier Spend",
  brief: "Continue this app",
  connections: [],
  modelId: "openai/gpt-6-luna",
  repository: { private: true, requestedName: "supplier-spend" },
  sourceCandidate: {
    appId: "supplier-spend",
    kind: "application-source-candidate-v1",
    manifestDigest: verified.manifestDigest,
    uploadId: "123e4567-e89b-42d3-a456-426614174000",
  },
});

it("checks the exact owner before and after completed artifact I/O", async () => {
  const observed: string[] = [];
  const validate = createOwnedSourceCandidateValidator({
    isActiveMember: async (current) => {
      expect(current).toEqual(authority);
      observed.push("membership");
      return true;
    },
    readCompleted: async (selection) => {
      expect(selection).toEqual({ authority, reference: intent.sourceCandidate });
      observed.push("artifact");
      return verified.artifact;
    },
  });
  await validate({ authority, intent });
  expect(observed).toEqual(["membership", "artifact", "membership"]);
});

it("denies acknowledgment when membership is revoked during artifact read", async () => {
  let active = true;
  const validate = createOwnedSourceCandidateValidator({
    isActiveMember: async () => active,
    readCompleted: async () => {
      active = false;
      return verified.artifact;
    },
  });
  await expect(validate({ authority, intent })).rejects.toThrow();
});

it("does not read source for an inactive member", async () => {
  let reads = 0;
  const validate = createOwnedSourceCandidateValidator({
    isActiveMember: async () => false,
    readCompleted: async () => {
      reads += 1;
      return verified.artifact;
    },
  });
  await expect(validate({ authority, intent })).rejects.toThrow();
  expect(reads).toBe(0);
});
