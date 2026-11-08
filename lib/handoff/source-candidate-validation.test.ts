import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { builderHandoffIntentSchema } from "./contracts";
import { validateApplicationSourceArtifact } from "./application-source-bytes";
import { createOwnedSourceCandidateValidator } from "./source-candidate-validation";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace-one",
  ownerUserId: "user-one",
};
const content = Buffer.from("source data");
const verified = validateApplicationSourceArtifact({
  manifest: {
    version: 1,
    kind: "application-source-v1",
    appId: "supplier-spend",
    displayName: "Supplier Spend",
    sourceSessionId: "local-source",
    files: [
      {
        path: "apps/supplier-spend/README.md",
        mode: "100644",
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
    omissions: [],
  },
  files: [{ path: "apps/supplier-spend/README.md", contentBase64: content.toString("base64") }],
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
    isActiveMember: (current) => {
      expect(current).toEqual(authority);
      observed.push("membership");
      return Promise.resolve(true);
    },
    readCompleted: (selection) => {
      expect(selection).toEqual({ authority, reference: intent.sourceCandidate });
      observed.push("artifact");
      return Promise.resolve(verified.artifact);
    },
  });
  await validate({ authority, intent });
  expect(observed).toEqual(["membership", "artifact", "membership"]);
});

it("denies acknowledgment when membership is revoked during artifact read", async () => {
  let active = true;
  const validate = createOwnedSourceCandidateValidator({
    isActiveMember: () => Promise.resolve(active),
    readCompleted: () => {
      active = false;
      return Promise.resolve(verified.artifact);
    },
  });
  await expect(validate({ authority, intent })).rejects.toThrow();
});

it("does not read source for an inactive member", async () => {
  let reads = 0;
  const validate = createOwnedSourceCandidateValidator({
    isActiveMember: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    readCompleted: () => {
      reads += 1;
      return Promise.resolve(verified.artifact);
    },
  });
  await expect(validate({ authority, intent })).rejects.toThrow();
  expect(reads).toBe(0);
});
