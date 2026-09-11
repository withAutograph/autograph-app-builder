import { defineTool } from "eve/tools";
import { z } from "zod";
import { HOSTED_MANAGED_SKILL_CONTENTS } from "@/lib/sandbox/hosted-managed-seeds.generated";

export const readSkillReferenceInputSchema = z.discriminatedUnion("skill", [
  z.strictObject({
    skill: z.literal("design-app"),
    reference: z.enum([
      "references/app-spec.md",
      "references/interactions.md",
      "references/questions.md",
      "references/target-repository-routing.md",
    ]),
  }),
  z.strictObject({
    skill: z.literal("plan-app-creation"),
    reference: z.literal("references/app-contract-v1.md"),
  }),
]);

export default defineTool({
  description:
    "Read one allowlisted reference bundled with an already selected top-level app-creation skill. Use load_skill only for the top-level skill name, then use this tool for its named reference file. This tool cannot read target repository files or arbitrary paths.",
  inputSchema: readSkillReferenceInputSchema,
  async execute({ skill, reference }) {
    const bundled = HOSTED_MANAGED_SKILL_CONTENTS.find(
      (file) => file.path === `${skill}/${reference}`,
    );
    if (!bundled)
      throw new Error("The selected skill reference is not bundled.");
    return {
      skill,
      reference,
      content: bundled.content,
    };
  },
});
