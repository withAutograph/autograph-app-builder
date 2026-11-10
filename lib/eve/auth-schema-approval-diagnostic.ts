/* oxlint-disable anti-slop/no-runtime-typeof -- This diagnostic is the boundary for malformed native JSON; representations are copied as own data before any safe projection. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";
import {
  authSchemaRolloutApprovalSchema,
  authSchemaRolloutApprovalReferenceSchema,
  authSchemaRolloutApprovalReference,
  authSchemaRolloutDigest,
} from "../provisioning/production-auth-schema-rollout-contract";
import type { AuthSchemaRolloutApproval } from "../provisioning/production-auth-schema-rollout-contract";
import type { PrivateHistoryObservation } from "./same-origin-http";

type Json = z.infer<ReturnType<typeof z.json>>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const topKeys = Object.keys(authSchemaRolloutApprovalSchema.shape);
const topKeySet = new Set(topKeys);
const referenceKeys = Object.keys(authSchemaRolloutApprovalReferenceSchema.shape);
const referenceKeySet = new Set(referenceKeys);
const OUTPUT_LIMIT = 32;
const APPLY_TOOL = "apply-production-auth-schema-rollout";
const TOOL_APPROVAL = "tool-approval";
const pathKeys = new Set([
  ...topKeys,
  ...referenceKeys,
  "authority",
  "issuer",
  "audience",
  "workspaceId",
  "ownerUserId",
  "sessionId",
  "profileId",
  "resourceId",
  "environment",
  "hostname",
  "port",
  "database",
  "schema",
  "migratorRole",
  "runtimeRole",
  "neon",
  "projectId",
  "branchId",
  "kind",
  "family",
  "catalogPath",
  "catalogSha256",
  "sources",
  "builder",
  "arrusted",
  "sha",
  "tree",
  "owner",
  "sql",
  "sha256",
]);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native exceptions and malformed JSON must not be coerced or invoke accessors in diagnostics.
const jsonData = (value: unknown, parents = new Set<object>()): Json => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "object" || parents.has(value)) {
    throw new Error("unavailable_json");
  }
  const next = new Set(parents).add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((entry) => !Object.hasOwn(entry, "value"))) {
    throw new Error("unavailable_json");
  }
  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_, index) =>
      jsonData(descriptors[String(index)]?.value, next),
    );
  }
  return Object.fromEntries(
    Object.entries(descriptors).flatMap(([key, entry]) =>
      entry.enumerable === true ? [[key, jsonData(entry.value, next)]] : [],
    ),
  );
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This closed category never returns input content.
const inputKind = (value: unknown) => {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return ["object", "string", "number", "boolean", "undefined"].includes(typeof value)
    ? typeof value
    : "other";
};

const issuePath = (path: PropertyKey[]) =>
  path.map((part) => {
    if (typeof part === "number" && Number.isSafeInteger(part) && part >= 0) {
      return part;
    }
    return typeof part === "string" && pathKeys.has(part) ? part : "other";
  });

const schemaIssueProjection = (issues: z.ZodError["issues"]) => ({
  schemaIssueCount: issues.length,
  schemaIssuesOmitted: Math.max(0, issues.length - OUTPUT_LIMIT),
  schemaIssues: issues
    .slice(0, OUTPUT_LIMIT)
    .map((issue) => ({ code: issue.code, path: issuePath(issue.path) })),
});

/** Closed comparison only. It cannot accept an approval or expose SQL, identities, arbitrary keys or issue messages. */
export const projectAuthSchemaApprovalInput = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Actual native tool input is untrusted until parsed.
  input: unknown,
  frozen: AuthSchemaRolloutApproval,
): Json => {
  const expected = authSchemaRolloutApprovalSchema.parse(frozen);
  let data: Json;
  try {
    data = jsonData(input);
  } catch {
    return { inputKind: inputKind(input), jsonAvailable: false, schemaValid: false };
  }
  const object = data !== null && typeof data === "object" && !Array.isArray(data) ? data : {};
  const keys = Object.keys(object);
  if (object.version === 2) {
    const reference = authSchemaRolloutApprovalReference(expected);
    const referenceFields = z.record(z.string(), z.json()).parse(reference);
    const parsedReference = authSchemaRolloutApprovalReferenceSchema.safeParse(data);
    return {
      inputKind: inputKind(input),
      comparisonKind: "reference",
      jsonAvailable: true,
      knownTopKeysPresent: referenceKeys.filter((key) => Object.hasOwn(object, key)),
      unknownTopKeyCount: keys.filter((key) => !referenceKeySet.has(key)).length,
      schemaValid: parsedReference.success,
      ...schemaIssueProjection(parsedReference.success ? [] : parsedReference.error.issues),
      inputSha256: authSchemaRolloutDigest(data),
      expectedReferenceSha256: authSchemaRolloutDigest(reference),
      expectedPlanSha256: authSchemaRolloutDigest(expected),
      referenceEqual: parsedReference.success && isDeepStrictEqual(parsedReference.data, reference),
      fieldsEqual: Object.fromEntries(
        referenceKeys.map((key) => [key, isDeepStrictEqual(object[key], referenceFields[key])]),
      ),
    };
  }
  const expectedFields = z.record(z.string(), z.json()).parse(expected);
  const parsed = authSchemaRolloutApprovalSchema.safeParse(data);
  const actualEffects = Array.isArray(object.effects) ? object.effects : [];
  return {
    inputKind: inputKind(input),
    jsonAvailable: true,
    knownTopKeysPresent: topKeys.filter((key) => Object.hasOwn(object, key)),
    unknownTopKeyCount: keys.filter((key) => !topKeySet.has(key)).length,
    schemaValid: parsed.success,
    ...schemaIssueProjection(parsed.success ? [] : parsed.error.issues),
    inputSha256: authSchemaRolloutDigest(data),
    expectedSha256: authSchemaRolloutDigest(expected),
    fullPlanEqual: parsed.success && isDeepStrictEqual(parsed.data, expected),
    fieldsEqual: Object.fromEntries(
      topKeys.map((key) => [key, isDeepStrictEqual(object[key], expectedFields[key])]),
    ),
    actualEffectCount: actualEffects.length,
    expectedEffectCount: expected.effects.length,
    effectComparisonsOmitted: Math.max(
      0,
      Math.max(actualEffects.length, expected.effects.length) - OUTPUT_LIMIT,
    ),
    effects: Array.from(
      { length: Math.min(OUTPUT_LIMIT, Math.max(actualEffects.length, expected.effects.length)) },
      (_, index) => {
        const entry = actualEffects[index];
        const actual =
          entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
        const planned = expected.effects[index];
        const sql = typeof actual.sql === "string" ? actual.sql : undefined;
        return {
          index,
          ownerEqual: planned !== undefined && actual.owner === planned.owner,
          sqlEqual: planned !== undefined && sql === planned.sql,
          declaredSha256Equal: planned !== undefined && actual.sha256 === planned.sha256,
          actualSqlBytes: sql === undefined ? null : Buffer.byteLength(sql, "utf-8"),
          expectedSqlBytes: planned === undefined ? null : Buffer.byteLength(planned.sql, "utf-8"),
          actualSqlSha256: sql === undefined ? null : hash(sql),
          expectedSqlSha256: planned === undefined ? null : hash(planned.sql),
        };
      },
    ),
  };
};

/** Diagnostics never replace status errors or contribute authority to the approval capture. */
const reportAuthSchemaApprovalDiagnostic = (value: Json): void => {
  try {
    console.info(JSON.stringify(value));
  } catch {
    // Logging is advisory and must not change the authorized status result.
  }
};

export const reportAuthSchemaApprovalDiagnosticFailure = (): void => {
  reportAuthSchemaApprovalDiagnostic({
    event: "builder.auth_schema_approval_prefix_diagnostic_failure",
    errorClass: "unavailable",
  });
};

export const diagnoseAuthSchemaApprovalPrefix = async (input: {
  plan: AuthSchemaRolloutApproval;
  endIndexExclusive: number;
  assertCurrent: () => Promise<void>;
  readHistory: (
    endIndexExclusive: number,
    onEvent: (event: MessageStreamEvent) => void,
  ) => Promise<PrivateHistoryObservation>;
}) => {
  const endIndexExclusive = z.number().int().positive().parse(input.endIndexExclusive);
  const expected = authSchemaRolloutApprovalSchema.parse(input.plan);
  await input.assertCurrent();
  let nativeIndex = 0;
  let requests = 0;
  let matchingTools = 0;
  let toolApprovalRequests = 0;
  const matchingRequests = new Map<string, string>();
  const observed = await input.readHistory(endIndexExclusive, (event) => {
    if (event.type === "input.requested") {
      for (const request of event.data.requests) {
        requests += 1;
        const toolApproval = request.kind === TOOL_APPROVAL;
        if (toolApproval) {
          toolApprovalRequests += 1;
        }
        const matching = toolApproval && request.action.toolName === APPLY_TOOL;
        const metadata = {
          event: "builder.auth_schema_approval_request_diagnostic",
          operationHash: hash(expected.operationRef),
          nativeIndex,
          requestKind: toolApproval ? TOOL_APPROVAL : "other",
          toolMatches: matching,
          requestHash: hash(request.requestId),
        };
        if (matching && request.kind === TOOL_APPROVAL) {
          matchingTools += 1;
          if (matchingTools > OUTPUT_LIMIT) {
            continue;
          }
          matchingRequests.set(request.requestId, request.action.callId);
          reportAuthSchemaApprovalDiagnostic({
            ...metadata,
            callHash: hash(request.action.callId),
            comparison: projectAuthSchemaApprovalInput(request.action.input, expected),
          });
        }
      }
    } else if (event.type === "approval.settled") {
      const callId = matchingRequests.get(event.data.requestId);
      if (callId !== undefined) {
        matchingRequests.delete(event.data.requestId);
        reportAuthSchemaApprovalDiagnostic({
          event: "builder.auth_schema_approval_settlement_diagnostic",
          operationHash: hash(expected.operationRef),
          requestHash: hash(event.data.requestId),
          callHash: hash(callId),
          nativeIndex,
          approved: event.data.outcome === "approved",
          ownerMatches: event.data.responderPrincipalId === expected.scope.authority.ownerUserId,
        });
      }
    }
    nativeIndex += 1;
  });
  await input.assertCurrent();
  reportAuthSchemaApprovalDiagnostic({
    event: "builder.auth_schema_approval_prefix_diagnostic",
    operationHash: hash(expected.operationRef),
    endIndexExclusive,
    nextNativeIndex: observed.nextNativeIndex,
    nativeTailIndex: observed.nativeTailIndex,
    complete: observed.complete,
    prefixComplete: observed.nextNativeIndex >= endIndexExclusive,
    requests,
    toolApprovalRequests,
    otherInputRequests: requests - toolApprovalRequests,
    matchingTools,
    matchingRequestsOmitted: Math.max(0, matchingTools - OUTPUT_LIMIT),
  });
};
