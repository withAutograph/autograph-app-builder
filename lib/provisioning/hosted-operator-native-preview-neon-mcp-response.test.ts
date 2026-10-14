import { describe, expect, it, vi } from "vitest";
import { readPreviewNeonMcpResponse } from "./hosted-operator-native-preview-neon-mcp-response";
import { privateMaintenanceUrl } from "./hosted-operator-native-preview-neon";
import { reportOperatorNeonMcpFailure } from "./hosted-operator-consent-diagnostic";
import type {
  OperatorNeonMcpFailure,
  HostedOperatorConsentDiagnosticSink,
} from "./hosted-operator-consent-diagnostic";

const scope = {
  branchId: "br-synthetic",
  endpointId: "ep-synthetic",
  hostname: "ep-synthetic.us-east-1.aws.neon.tech",
  maintenanceDatabase: "neondb",
  maintenanceRole: "bootstrap_owner",
  projectId: "native-project",
};
const credential = {
  branchId: scope.branchId,
  computeId: scope.endpointId,
  databaseName: scope.maintenanceDatabase,
  projectId: scope.projectId,
  roleName: scope.maintenanceRole,
  uri: `postgresql://bootstrap_owner:synthetic-private-password@${scope.hostname}/neondb?sslmode=require`,
};
const text = [
  "Connection string details:",
  `URI: ${credential.uri}`,
  `Project ID: ${credential.projectId}`,
  `Database: ${credential.databaseName}`,
  `Role: ${credential.roleName}`,
  `Branch ID: ${credential.branchId}`,
  `Compute ID: ${credential.computeId}`,
  "",
  "You can use this connection string with any PostgreSQL client to connect to your Neon database.",
].join("\n");
const response = (value: string) => ({ content: [{ type: "text", text: value }] });

describe("private Neon MCP connection response", () => {
  it("decodes the official labeled response that the previous JSON-only decoder rejects", () => {
    expect(() => {
      JSON.parse(text);
    }).toThrow(SyntaxError);
    const report = vi.fn<(phase: OperatorNeonMcpFailure["phase"]) => void>();
    expect(readPreviewNeonMcpResponse(response(text), true, report)).toEqual(credential);
    expect(report).not.toHaveBeenCalled();
    expect(privateMaintenanceUrl(credential.uri, scope)).toContain("sslmode=verify-full");
  });

  it("keeps JSON text and structuredContent compatibility", () => {
    const report = vi.fn<(phase: OperatorNeonMcpFailure["phase"]) => void>();
    expect(readPreviewNeonMcpResponse(response(JSON.stringify(credential)), true, report)).toEqual(
      credential,
    );
    expect(
      readPreviewNeonMcpResponse(
        { ...response(text), structuredContent: credential },
        true,
        report,
      ),
    ).toEqual(credential);
    expect(readPreviewNeonMcpResponse(response('{"id":"native-project"}'), false, report)).toEqual({
      id: scope.projectId,
    });
  });

  it.each(["URI", "Project ID", "Database", "Role", "Branch ID", "Compute ID"])(
    "rejects missing or duplicate %s without reporting private text",
    (label) => {
      for (const invalid of [
        text
          .split("\n")
          .filter((line) => !line.startsWith(`${label}:`))
          .join("\n"),
        `${text}\n${label}: conflicting-private-value`,
        `${text}\n${label}:`,
      ]) {
        const report = vi.fn<(phase: OperatorNeonMcpFailure["phase"]) => void>();
        expect(() => readPreviewNeonMcpResponse(response(invalid), true, report)).toThrow(
          /^Protected Preview Neon MCP credential is unavailable\.$/u,
        );
        expect(report).toHaveBeenCalledWith("response_decode");
        expect(JSON.stringify(report.mock.calls)).not.toContain("private");
      }
    },
  );

  it("never adapts metadata prose into credentials or accepts tool errors containing a URI", () => {
    const report = vi.fn<(phase: OperatorNeonMcpFailure["phase"]) => void>();
    expect(() => readPreviewNeonMcpResponse(response(text), false, report)).toThrow();
    expect(() =>
      readPreviewNeonMcpResponse({ ...response(text), isError: true }, true, report),
    ).toThrow();
    expect(report).toHaveBeenLastCalledWith("tool_error");
  });

  it.each([
    credential.uri.replace(scope.hostname, "other.neon.tech"),
    credential.uri.replace("bootstrap_owner:", "other_role:"),
    credential.uri.replace("/neondb?", "/other?"),
    credential.uri.replace("sslmode=require", "sslmode=disable"),
  ])("retains exact URI isolation for a parsed labeled response", (invalidUri) => {
    const result = readPreviewNeonMcpResponse(
      response(text.replace(credential.uri, invalidUri)),
      true,
      vi.fn<(phase: OperatorNeonMcpFailure["phase"]) => void>(),
    );
    expect(result).toMatchObject({ uri: invalidUri });
    expect(() => privateMaintenanceUrl(invalidUri, scope)).toThrow();
  });

  it("reports only closed SDK codes, HTTP status and phases", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const error = Object.assign(new Error(credential.uri), {
      code: -32_601,
      statusCode: 403,
      url: credential.uri,
      responseBody: text,
      data: credential,
    });
    reportOperatorNeonMcpFailure("private-owner-session", "tool_request", error, sink);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        neonMcpFailure: { phase: "tool_request", sdkCode: -32_601, httpStatus: 403 },
      }),
    );
    const logged = JSON.stringify(sink.mock.calls);
    for (const privateValue of [
      credential.uri,
      "synthetic-private-password",
      "private-owner-session",
      text,
    ]) {
      expect(logged).not.toContain(privateValue);
    }
    reportOperatorNeonMcpFailure("private-owner-session", "response_decode", undefined, sink);
    expect(sink).toHaveBeenLastCalledWith(
      expect.objectContaining({ neonMcpFailure: { phase: "response_decode" } }),
    );
  });
});
