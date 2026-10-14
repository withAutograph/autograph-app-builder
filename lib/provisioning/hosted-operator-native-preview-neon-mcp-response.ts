import { z } from "zod";
import type { OperatorNeonMcpFailure } from "./hosted-operator-consent-diagnostic";

const unavailable = () => new Error("Protected Preview Neon MCP credential is unavailable.");
const metadata = z.object({
  content: z.array(z.object({ text: z.string(), type: z.literal("text") })),
  isError: z.boolean().optional(),
  structuredContent: z.json().optional(),
});
const connectionFields = {
  branchId: "Branch ID",
  computeId: "Compute ID",
  databaseName: "Database",
  projectId: "Project ID",
  roleName: "Role",
  uri: "URI",
} as const;

/** Neon formats this host tool as labeled text, unlike its JSON Management API tools. */
const connectionStringText = (text: string) => {
  const lines = text.split(/\r?\n/u);
  return Object.fromEntries(
    Object.entries(connectionFields).map(([field, label]) => {
      const prefix = `${label}:`;
      const values = lines.flatMap((line) =>
        line.startsWith(prefix) ? [line.slice(prefix.length).trim()] : [],
      );
      if (values.length !== 1 || values[0] === "") {
        throw unavailable();
      }
      return [field, values[0]];
    }),
  );
};

/** Decode private wire data only. Callers must still check every identity and the maintenance URI. */
export const readPreviewNeonMcpResponse = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- MCP wire payload is parsed at this boundary before any field is read.
  value: unknown,
  connectionCredential: boolean,
  report: (phase: OperatorNeonMcpFailure["phase"]) => void,
) => {
  const parsed = metadata.safeParse(value);
  if (!parsed.success) {
    report("response_shape");
    throw parsed.error;
  }
  const result = parsed.data;
  if (result.isError === true) {
    report("tool_error");
    throw unavailable();
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  if (result.content.length !== 1) {
    report("response_shape");
    throw unavailable();
  }
  const text = result.content[0]?.text ?? "";
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    if (connectionCredential) {
      try {
        return connectionStringText(text);
      } catch {
        report("response_decode");
        throw unavailable();
      }
    }
    report("response_decode");
    throw unavailable();
  }
};
