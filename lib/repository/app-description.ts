import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";

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
        .nullable(),
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
    throw new Error(
      "The selected repository could not describe this app. Repair its app:describe command and retry.",
    );
  }
  const description = appDescriptionSchema.parse(JSON.parse(result.stdout));
  if (description.app.id !== input.appId) {
    throw new Error("The repository described a different application");
  }
  return description;
};
