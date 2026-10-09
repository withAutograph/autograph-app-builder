/* oxlint-disable anti-slop/no-module-mocking -- A minimal Eve state fixture exercises durable reference retention without a provider. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalSchemaPredecessorState,
  rememberCanonicalSchemaRelease,
} from "./schema-predecessor-state";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";

vi.mock("eve/context", () => ({
  defineState: <T>(_name: string, initial: () => T) => {
    let value = initial();
    return {
      get: () => value,
      update: (change: (current: T) => T) => {
        value = change(value);
      },
    };
  },
}));
const selection: CompiledOperatorReleaseSelection = {
  appId: "spend-review",
  appSpecDigest: "a".repeat(64),
  artifactRef: `_protected-operator/artifacts/generated-release/spend-review/${"b".repeat(64)}`,
  manifestSha256: "c".repeat(64),
  releaseId: "original-v2",
  schemaSha256: "d".repeat(64),
  version: 1,
};
describe("immutable compiled predecessor references", () => {
  beforeEach(() => {
    canonicalSchemaPredecessorState.update(() => []);
  });
  it("retains the original recorded reference across repeat compilation of the same identity", () => {
    rememberCanonicalSchemaRelease(selection);
    rememberCanonicalSchemaRelease({
      ...selection,
      artifactRef: `_protected-operator/artifacts/generated-release/spend-review/${"e".repeat(64)}`,
      manifestSha256: "f".repeat(64),
    });
    expect(canonicalSchemaPredecessorState.get()).toEqual([selection]);
  });
  it("preserves earlier exact identities when a new release is compiled", () => {
    rememberCanonicalSchemaRelease(selection);
    const newer = { ...selection, releaseId: "new-v3", schemaSha256: "e".repeat(64) };
    rememberCanonicalSchemaRelease(newer);
    expect(canonicalSchemaPredecessorState.get()).toEqual([selection, newer]);
  });
});
