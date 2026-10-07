import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";
import { sanitizeValidationDiagnosticText } from "./validation-output-sanitize";

const appId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
export const appDescriptionSchema = z.object({
  app: z.object({ id: appId, routes: z.array(z.string()), workspacePath: z.string() }),
  backend: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("static") }),
    z.object({
      authorization: z.enum(["declared-policy", "app-owned"]),
      kind: z.literal("generated-postgres"),
      release: z.object({ artifactHash: z.string(), directory: z.string(), id: z.string() }),
      roles: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/u)),
      runtime: z.object({ databaseEnvironment: z.string() }),
      schemaReceipt: z
        .object({ contract: z.literal("authenticated-release-read"), path: z.string() })
        .nullable()
        .default(null),
    }),
  ]),
  validation: z.object({
    browser: z.object({ task: z.string() }).nullable(),
    check: z.object({ task: z.string() }),
    test: z.object({ shards: z.number().int().positive(), task: z.string() }),
  }),
  version: z.literal(1),
});
export type AppDescription = z.infer<typeof appDescriptionSchema>;

const sourceDiagnosticSchema = z.strictObject({
  baselinePlatformHead: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/u)
    .nullable(),
  configOverridePresent: z.boolean(),
  configuration: z
    .array(
      z.strictObject({
        path: z.enum(["mise.toml", ".mise.toml", ".config/mise/config.toml"]),
        state: z.enum(["declared", "absent", "unavailable"]),
      }),
    )
    .max(3),
  descriptionScriptExists: z.boolean(),
  sourceHead: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/u)
    .nullable(),
  workingDirectoryMatchesRoot: z.boolean(),
});

/** Read-only source facts; deliberately excludes config contents, environment values and remotes. */
export const appDescriptionSourceInspectionProgram = String.raw`
const { readFileSync, existsSync, statSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const root = resolve(process.argv[2] ?? process.cwd());
const validHead = value => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value) ? value : null;
const git = spawnSync("git", ["-c", "core.fsmonitor=false", "rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
let baselinePlatformHead = null;
try {
  const marker = JSON.parse(readFileSync(resolve(root, ".app-builder/app-baselines/" + process.argv[1] + ".json"), "utf8"));
  baselinePlatformHead = validHead(marker.receipt?.platform?.commitSha);
} catch {}
const configuration = ["mise.toml", ".mise.toml", ".config/mise/config.toml"].map(path => {
  try {
    if (!existsSync(resolve(root, path))) return { path, state: "absent" };
    if (statSync(resolve(root, path)).size > 1024 * 1024) return { path, state: "unavailable" };
    const content = readFileSync(resolve(root, path), "utf8");
    return { path, state: /^\s*\[tasks\.(?:"app:describe"|\x27app:describe\x27)\]/m.test(content) ? "declared" : "absent" };
  } catch { return { path, state: "unavailable" }; }
});
console.log(JSON.stringify({ sourceHead: validHead(git.status === 0 ? git.stdout.trim() : null), baselinePlatformHead, configuration,
  descriptionScriptExists: existsSync(resolve(root, ".config/mise/scripts/repository/app-describe.ts")), workingDirectoryMatchesRoot: resolve(process.cwd()) === root, configOverridePresent: Boolean(process.env.MISE_CONFIG_FILE) }));
`;

const quoteCommandArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const describeFailureSourceDiagnostic = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run">;
  signal?: AbortSignal;
}): Promise<string> => {
  try {
    const request: Parameters<SandboxSession["run"]>[0] = {
      command: `node -e '${appDescriptionSourceInspectionProgram}' ${appId.parse(input.appId)} ${quoteCommandArgument(input.root)}`,
      workingDirectory: input.root,
    };
    if (input.signal !== undefined) {
      request.abortSignal = input.signal;
    }
    const result = await input.sandbox.run(request);
    if (result.exitCode !== 0) {
      return "";
    }
    const facts = sourceDiagnosticSchema.safeParse(JSON.parse(result.stdout));
    return facts.success ? ` Source inspection: ${JSON.stringify(facts.data)}.` : "";
  } catch {
    return "";
  }
};

/** Repository commands describe capabilities; the Builder does not parse its internal layout. */
export const describeSelectedApp = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run">;
  signal?: AbortSignal;
}): Promise<AppDescription> => {
  const command: Parameters<SandboxSession["run"]>[0] = {
    command: `mise run app:describe ${appId.parse(input.appId)}`,
    workingDirectory: input.root,
  };
  if (input.signal !== undefined) {
    command.abortSignal = input.signal;
  }
  const result = await input.sandbox.run(command);
  if (result.exitCode !== 0) {
    const diagnostic = sanitizeValidationDiagnosticText(result.stderr || result.stdout)
      .replaceAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/giu, "[URL REDACTED]")
      .trim();
    const sourceDiagnostic = await describeFailureSourceDiagnostic(input);
    throw new Error(
      `The selected repository could not describe this app (app:describe exited ${result.exitCode}). Repair its app:describe command and retry. Cause: ${diagnostic || "The command returned no diagnostic output."}${sourceDiagnostic}`,
    );
  }
  const description = appDescriptionSchema.parse(JSON.parse(result.stdout));
  if (description.app.id !== input.appId) {
    throw new Error("The repository described a different application");
  }
  return description;
};
