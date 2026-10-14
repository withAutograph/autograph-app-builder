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

describe("Neon MCP owned pooler maintenance URI", () => {
  const pooledUri = credential.uri.replace(scope.hostname, scope.hostname.replace(".", "-pooler."));
  const options = { allowOwnedPooler: true };
  it("rejects the SDK's default pooled fixture under the prior policy and normalizes the exact endpoint only for MCP", () => {
    expect(() => privateMaintenanceUrl(pooledUri, scope)).toThrow();
    const normalized = new URL(privateMaintenanceUrl(pooledUri, scope, options));
    expect(normalized.hostname).toBe(scope.hostname);
    expect(normalized.username).toBe(scope.maintenanceRole);
    expect(normalized.password).toBe("synthetic-private-password");
    expect(normalized.pathname).toBe(`/${scope.maintenanceDatabase}`);
    expect(normalized.searchParams.get("sslmode")).toBe("verify-full");
    expect(privateMaintenanceUrl(credential.uri, scope, options)).toBe(
      privateMaintenanceUrl(credential.uri, scope),
    );
  });

  it.each([
    "ep-other-pooler.us-east-1.aws.neon.tech",
    "ep-synthetic-pooler.us-west-2.aws.neon.tech",
    "ep-synthetic-pooler.us-east-1.aws.neon.tech.attacker.example",
    "ep-synthetic-pooler-pooler.us-east-1.aws.neon.tech",
    "ep-synthetic.us-east-1-pooler.aws.neon.tech",
  ])("rejects a pooler outside the exact verified endpoint pair", (hostname) => {
    const invalid = new URL(pooledUri);
    invalid.hostname = hostname;
    expect(() => privateMaintenanceUrl(invalid.href, scope, options)).toThrow();
  });

  it.each([
    ["role", pooledUri.replace("bootstrap_owner:", "other_role:")],
    ["database", pooledUri.replace("/neondb?", "/other?")],
    ["port", pooledUri.replace("/neondb?", ":6543/neondb?")],
    ["password", pooledUri.replace(":synthetic-private-password@", "@")],
    ["tls_mode", pooledUri.replace("sslmode=require", "sslmode=disable")],
    ["tls_count", `${pooledUri}&sslmode=require`],
    ["query_keys", `${pooledUri}&options=private-provider-input`],
    ["channel_binding_count", `${pooledUri}&channel_binding=require&channel_binding=require`],
    ["channel_binding_value", `${pooledUri}&channel_binding=disable`],
    ["fragment", `${pooledUri}#private-provider-input`],
  ] as const)("preserves the %s guard and reports only its fixed label", (field, invalidUri) => {
    const mismatches = vi.fn<(fields: string[]) => void>();
    expect(() =>
      privateMaintenanceUrl(invalidUri, scope, { ...options, reportMismatch: mismatches }),
    ).toThrow(/^Protected native Preview credential is unavailable\.$/u);
    expect(mismatches).toHaveBeenCalledWith(expect.arrayContaining([field]));
    expect(JSON.stringify(mismatches.mock.calls)).not.toContain(invalidUri);
    expect(JSON.stringify(mismatches.mock.calls)).not.toContain("synthetic-private-password");
  });

  it("reports closed parsing failures and ignores a throwing diagnostic callback", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    expect(() =>
      privateMaintenanceUrl("invalid-private-uri", scope, {
        ...options,
        reportMismatch: (fields) => {
          reportOperatorNeonMcpFailure(
            "private-owner-session",
            "credential_uri",
            undefined,
            sink,
            fields,
          );
        },
      }),
    ).toThrow();
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        neonMcpFailure: { phase: "credential_uri", uriMismatch: ["url"] },
      }),
    );
    expect(JSON.stringify(sink.mock.calls)).not.toContain("invalid-private-uri");
    expect(() =>
      privateMaintenanceUrl("invalid-private-uri", scope, {
        ...options,
        reportMismatch: () => {
          throw new Error("private-callback-error");
        },
      }),
    ).toThrow(/^Protected native Preview credential is unavailable\.$/u);
  });
});
