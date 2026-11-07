import { z } from "zod";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import type { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import type { HostedOperatorPlan } from "./hosted-operator-contract";

type AuthSchemaSelection = NonNullable<HostedOperatorPlan["authSchema"]>;
export type AuthOnlySchemaArtifactBinding = {
  context: OperatorArtifactContext;
  /** Taken from the exact plan settled through authenticated private history. */
  selection: Readonly<Omit<AuthSchemaSelection, "installer">> & {
    readonly installer: Readonly<AuthSchemaSelection["installer"]>;
  };
  worker: Readonly<{ id: string; sha256: string }>;
};
type AuthPlanReader = ReturnType<typeof createOperatorArtifactPublication>["readAuthPlan"];
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const frameSchema = z.object({
  schemaPlan: z.object({ planDigest: sha256, targetDigest: sha256 }),
});
const mismatch = () => new Error("native_target_auth_only_schema_artifact_mismatch");

/**
 * Reads already-published, already-approved Auth schema bytes. It creates no approval,
 * source provenance, proposal, credentials or provider resource. Inject the existing
 * owner/session-bound publication.readAuthPlan, never a public artifact reader.
 */
export const createAuthOnlySchemaArtifactReader = (ports: {
  readAuthPlan: AuthPlanReader;
  /** Re-read current owner, settled approval and selected worker around artifact I/O. */
  assertCurrentApproval: (binding: AuthOnlySchemaArtifactBinding) => Promise<void>;
}) => ({
  async read(input: AuthOnlySchemaArtifactBinding): ReturnType<AuthPlanReader> {
    // Neither the caller nor an asynchronous port can replace the approved selection.
    const binding = structuredClone(input);
    const { selection, worker } = binding;
    if (worker.id !== selection.installer.reference || worker.sha256 !== selection.installer.sha256)
      throw mismatch();
    await ports.assertCurrentApproval(structuredClone(binding));
    const artifact = await ports.readAuthPlan(structuredClone(binding.context), {
      artifactRef: selection.artifactRef,
      planDigest: selection.planDigest,
      targetDigest: selection.targetDigest,
    });
    const content = Buffer.from(artifact.content);
    if (artifact.artifactRef !== selection.artifactRef) throw mismatch();
    let frame: z.infer<typeof frameSchema>;
    try {
      frame = frameSchema.parse(JSON.parse(content.toString("utf-8")));
    } catch {
      throw mismatch();
    }
    if (
      frame.schemaPlan.planDigest !== selection.planDigest ||
      frame.schemaPlan.targetDigest !== selection.targetDigest
    )
      throw mismatch();
    await ports.assertCurrentApproval(structuredClone(binding));
    return { artifactRef: selection.artifactRef, content };
  },
});
