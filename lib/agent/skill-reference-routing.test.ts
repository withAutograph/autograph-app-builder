import { readFile } from "node:fs/promises";

import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

import readSkillReference, {
  readSkillReferenceInputSchema,
} from "../../agent/tools/read_skill_reference";

describe("skill reference routing", () => {
  it.each([
    {
      skill: "design-app",
      reference: "references/questions.md",
    },
    {
      skill: "design-app",
      reference: "references/app-spec.md",
    },
    {
      skill: "design-app",
      reference: "references/target-repository-routing.md",
    },
    {
      skill: "plan-app-creation",
      reference: "references/app-contract-v1.md",
    },
  ])("accepts the bundled $skill $reference file", (input) => {
    expect(readSkillReferenceInputSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    {
      skill: "design-app/references/app-spec.md",
      reference: "references/app-spec.md",
    },
    {
      skill: "design-app",
      reference: "SKILL.md",
    },
    {
      skill: "design-app",
      reference: "../../repository/package.json",
    },
    {
      skill: "create-app",
      reference: "references/app-spec.md",
    },
  ])("rejects non-reference routing %#", (input) => {
    expect(readSkillReferenceInputSchema.safeParse(input).success).toBe(false);
  });

  it("reads through the selected skill package handle", async () => {
    const text = vi.fn(async () => "# App contract");
    const file = vi.fn(() => ({ text }));
    const getSkill = vi.fn(() => ({ file }));

    await expect(
      readSkillReference.execute(
        {
          skill: "plan-app-creation",
          reference: "references/app-contract-v1.md",
        },
        { getSkill } as unknown as ToolContext,
      ),
    ).resolves.toEqual({
      skill: "plan-app-creation",
      reference: "references/app-contract-v1.md",
      content: "# App contract",
    });
    expect(getSkill).toHaveBeenCalledWith("plan-app-creation");
    expect(file).toHaveBeenCalledWith("references/app-contract-v1.md");
    expect(text).toHaveBeenCalledOnce();
  });

  it("teaches top-level skill loading and separate reference reads", async () => {
    const [instructions, design, planning] = await Promise.all([
      readFile("agent/instructions.md", "utf8"),
      readFile("agent/skills/design-app/SKILL.md", "utf8"),
      readFile("agent/skills/plan-app-creation/SKILL.md", "utf8"),
    ]);

    expect(instructions).toContain(
      "`load_skill` accepts only an exact top-level skill name",
    );
    expect(instructions).toContain("use `read_skill_reference`");
    expect(design).toMatch(/Never pass a reference path to\s+`load_skill`/u);
    expect(design).toContain("`design-app` and `references/app-spec.md`");
    expect(planning).toContain(
      "`plan-app-creation` and `references/app-contract-v1.md`",
    );
  });
});
