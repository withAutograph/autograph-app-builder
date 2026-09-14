import { describe, expect, it } from "vitest";
import { freshBootstrapProposalSchema } from "./fresh-bootstrap-schema";
import { stableDigest } from "../repository/local-publication";

const identity = {
  device: "1",
  inode: "2",
  mode: "755",
  nlink: "1",
  path: "/usr/bin/tool",
  sha256: "a".repeat(64),
  uid: "0",
};

describe("fresh bootstrap executable identity transport", () => {
  it.each([
    "lockHelperIdentity",
    "systemGitIdentity",
    "systemNodeIdentity",
    "systemPythonIdentity",
  ] as const)("preserves producer digest bytes for %s", (field) => {
    const schema = freshBootstrapProposalSchema.shape.capability.shape[field];
    const serialized = JSON.stringify(identity);
    const parsed = schema.parse(JSON.parse(serialized));
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(identity));
    expect(stableDigest(parsed)).toBe(stableDigest(identity));
    expect(() => schema.parse({ ...identity, sha256: "tampered" })).toThrow();
    expect(() => schema.parse({ ...identity, unexpected: true })).toThrow();
  });
});
