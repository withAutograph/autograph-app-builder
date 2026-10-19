import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { reportHostedRuntimeHandoffDiagnostic } from "./hosted-runtime-handoff-diagnostic";

const secret =
  "private-app-id https://private.example/identity?token=secret SELECT * FROM private_payload";
const eventName = "autograph.hosted-runtime.handoff-diagnostic";
const logRecordSchema = z.looseObject({
  acceptedAppIdPresent: z.boolean().optional(),
  appIdMatches: z.boolean().optional(),
  appIdPresent: z.boolean().optional(),
  appIdValid: z.boolean().optional(),
  event: z.literal(eventName),
  eventCompleted: z.boolean().optional(),
  inputAppIdPresent: z.boolean().optional(),
  isError: z.boolean().optional(),
  lookupAttempted: z.boolean().optional(),
  operationRefPresent: z.boolean().optional(),
  operationRefValid: z.boolean().optional(),
  outcome: z.enum(["retained", "ineligible", "invalid_reference", "failed"]).optional(),
  outputKind: z.enum(["other", "null", "object", "string"]).optional(),
  outputStatus: z.string().optional(),
  planDigestPresent: z.boolean().optional(),
  planDigestValid: z.boolean().optional(),
  referenceState: z.enum(["absent", "invalid", "present"]).optional(),
  selectionPresent: z.boolean().optional(),
  stage: z.string(),
  statusPresent: z.boolean().optional(),
});

const readRecord = (line: string) => logRecordSchema.parse(JSON.parse(line));

describe("hosted runtime handoff diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("projects only closed result classifications and reference presence or validity", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    reportHostedRuntimeHandoffDiagnostic({
      eventCompleted: true,
      isError: false,
      output: {
        appId: "private-app-id",
        operationRef: "123e4567-e89b-42d3-a456-426614174000",
        planDigest: "a".repeat(64),
        status: "prepared",
        privatePayload: secret,
        privateUrl: "https://private.example/identity?token=secret",
      },
      stage: "owner_action_result",
    });

    const record = readRecord(String(info.mock.calls[0]?.[0]));
    expect(record).toEqual({
      appIdPresent: true,
      appIdValid: true,
      event: eventName,
      eventCompleted: true,
      isError: false,
      operationRefPresent: true,
      operationRefValid: true,
      outputKind: "object",
      outputStatus: "prepared",
      planDigestPresent: true,
      planDigestValid: true,
      stage: "owner_action_result",
      statusPresent: true,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(info.mock.calls)).not.toContain("private.example");
  });

  it.each([
    "planned",
    "pending",
    "prepared",
    "cleaned",
    "blocked",
    "auth-schema-prepared",
    "participants-prepared",
    "waiting_for_signup",
    "ready",
  ])("accepts only the operator's closed output status %s", (status) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    reportHostedRuntimeHandoffDiagnostic({
      eventCompleted: false,
      isError: true,
      output: { status },
      stage: "owner_action_result",
    });

    const record = readRecord(String(info.mock.calls[0]?.[0]));
    expect(record.outputStatus).toBe(status);
  });

  it("marks malformed private values invalid and never copies them into the record", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    reportHostedRuntimeHandoffDiagnostic({
      eventCompleted: true,
      isError: false,
      output: {
        appId: secret,
        operationRef: secret,
        planDigest: secret,
        status: secret,
      },
      stage: "owner_action_result",
    });

    const serialized = String(info.mock.calls[0]?.[0]);
    const record = readRecord(serialized);
    expect(record).toMatchObject({
      appIdPresent: true,
      appIdValid: true,
      operationRefPresent: true,
      operationRefValid: false,
      outputStatus: "invalid",
      planDigestPresent: true,
      planDigestValid: false,
      statusPresent: true,
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private.example");
  });

  it("keeps marker and optional enum metadata closed", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    reportHostedRuntimeHandoffDiagnostic({ stage: "hook_module_loaded" });
    reportHostedRuntimeHandoffDiagnostic({ outcome: "retained", stage: "reference_capture" });
    reportHostedRuntimeHandoffDiagnostic({
      referenceState: "present",
      selectionPresent: true,
      stage: "owner_selection_read",
    });
    reportHostedRuntimeHandoffDiagnostic({
      acceptedAppIdPresent: true,
      appIdMatches: false,
      inputAppIdPresent: true,
      lookupAttempted: true,
      stage: "native_preview_candidate",
    });
    const records = info.mock.calls.map(([line]) => readRecord(String(line)));
    expect(records).toEqual([
      { event: eventName, stage: "hook_module_loaded" },
      { event: eventName, outcome: "retained", stage: "reference_capture" },
      {
        event: eventName,
        referenceState: "present",
        selectionPresent: true,
        stage: "owner_selection_read",
      },
      {
        acceptedAppIdPresent: true,
        appIdMatches: false,
        event: eventName,
        inputAppIdPresent: true,
        lookupAttempted: true,
        stage: "native_preview_candidate",
      },
    ]);
    expect(JSON.stringify(records)).not.toContain(secret);
  });

  it("does not invoke throwing accessors or propagate hostile proxy and logger failures", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const accessorOutput = Object.defineProperty({}, "status", {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
    const hostileProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error(secret);
        },
      },
    );

    expect(() => {
      reportHostedRuntimeHandoffDiagnostic({
        eventCompleted: true,
        isError: false,
        output: accessorOutput,
        stage: "owner_action_result",
      });
    }).not.toThrow();
    expect(() => {
      reportHostedRuntimeHandoffDiagnostic({
        eventCompleted: true,
        isError: false,
        output: hostileProxy,
        stage: "owner_action_result",
      });
    }).not.toThrow();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).not.toContain(secret);

    info.mockImplementation(() => {
      throw new Error(secret);
    });
    expect(() => {
      reportHostedRuntimeHandoffDiagnostic({ stage: "hook_module_loaded" });
    }).not.toThrow();
  });
});
