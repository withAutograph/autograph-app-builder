import { describe, expect, it } from "vitest";
import {
  assertHostedOperatorSharedGateway,
  describeHostedOperatorSharedGateway,
} from "./hosted-operator-shared-gateway";
import type { SharedAuthAdoption } from "./hosted-operator-contract";

const operationRef = "7a111111-1111-4111-8111-111111111111";
const source = {
  publicGateway: { branch: "preview", origin: "https://gateway.example", projectId: "gateway" },
};
const rows = () =>
  [
    "AUTH_DATABASE_RESOURCE",
    "PLATFORM_AUTH_DATABASE_URL",
    "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
    "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
    "PLATFORM_GATEWAY_PROJECT_BINDINGS",
  ].map((key, index) => ({
    branch: "preview",
    comment: `App Builder protected operator ${operationRef}`,
    id: `row-${index}`,
    key,
    operationRef,
    projectId: "gateway",
    valueSha256: "a".repeat(64),
  }));
const adoption = (): SharedAuthAdoption => ({
  gatewayEnvironment: describeHostedOperatorSharedGateway(source, rows()),
  kind: "owned-journal-auth-v1",
  resource: {
    authDatabase: {
      database: "auth",
      migratorRole: "auth_owner",
      resourceId: "auth",
      runtimeRole: "auth_runtime",
    },
    branchId: "branch",
    endpoint: "db.example",
    endpointId: "endpoint",
    projectId: "neon",
  },
  source: {
    checkpointSha256: "b".repeat(64),
    journalDigest: "c".repeat(64),
    operationRef,
    planDigest: "d".repeat(64),
    selection: {
      appId: "first",
      branch: "preview",
      environment: "preview",
      projectId: "first",
      sessionId: "session",
    },
  },
});

describe("canonical shared Gateway journal snapshot", () => {
  it("retains prior operations and compares the complete snapshot independent of row order", () => {
    const target = { ...source, authAdoption: adoption() };
    expect(assertHostedOperatorSharedGateway(target, source, rows().toReversed())).toEqual(
      target.authAdoption.gatewayEnvironment,
    );
  });
  it("rejects legacy references without independently checkpointed value hashes", () => {
    const legacy = rows().map(({ valueSha256: _hash, ...row }) => {
      void _hash;
      return row;
    });
    expect(() => describeHostedOperatorSharedGateway(source, legacy)).toThrow();
  });
  it("rejects a source checkpoint that still has an unresolved provider write", () => {
    const pending = rows();
    Object.assign(pending[0], {
      pendingOperationRef: operationRef,
      pendingValueSha256: "f".repeat(64),
    });
    expect(() => describeHostedOperatorSharedGateway(source, pending)).toThrow();
  });
  it.each([
    "missing",
    "duplicate-key",
    "duplicate-id",
    "foreign-project",
    "foreign-branch",
    "forged-comment",
  ])("rejects %s journal ownership", (failure) => {
    const entries = rows();
    const [first] = entries;
    if (failure === "missing") {
      entries.pop();
    }
    if (failure === "duplicate-key") {
      entries[1].key = first.key;
    }
    if (failure === "duplicate-id") {
      entries[1].id = first.id;
    }
    if (failure === "foreign-project") {
      first.projectId = "other";
    }
    if (failure === "foreign-branch") {
      first.branch = "main";
    }
    if (failure === "forged-comment") {
      first.comment = "unowned";
    }
    expect(() => describeHostedOperatorSharedGateway(source, entries)).toThrow();
  });
  it("rejects source value replacement after approval and a foreign target Gateway", () => {
    const target = { ...source, authAdoption: adoption() };
    const changed = rows();
    changed[0].valueSha256 = "e".repeat(64);
    expect(() => assertHostedOperatorSharedGateway(target, source, changed)).toThrow();
    expect(() =>
      assertHostedOperatorSharedGateway(
        {
          ...target,
          publicGateway: {
            ...source.publicGateway,
            projectId: "other",
          },
        },
        source,
        rows(),
      ),
    ).toThrow();
  });
});
