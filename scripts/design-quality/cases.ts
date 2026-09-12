import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

const caseId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const designCaseSchema = z.object({
  id: caseId,
  title: z.string().min(1),
  status: z.string().min(1),
  notes: z.string(),
  evidence: z.array(
    z.object({
      repo: z.string().min(1),
      path: z.string().min(1),
      status: z.string().min(1),
    }),
  ),
  reviewQuestions: z.array(z.string().min(1)),
  outcomes: z.array(z.string().min(1)),
});

export type DesignCase = z.infer<typeof designCaseSchema>;
export type ListedDesignCase = Pick<DesignCase, "id" | "title" | "status">;

export function designCasesRoot(root = "docs/design-quality-cases") {
  return resolve(root);
}

function caseDirectory(id: string, root?: string) {
  return join(designCasesRoot(root), caseId.parse(id));
}

export async function listDesignCases(root?: string): Promise<ListedDesignCase[]> {
  const base = designCasesRoot(root);
  const entries = await readdir(base, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const cases = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && caseId.safeParse(entry.name).success)
      .map(async (entry) => {
        const metadata = designCaseSchema.parse(
          JSON.parse(await readFile(join(base, entry.name, "case.json"), "utf8")),
        );
        if (metadata.id !== entry.name)
          throw new Error(`Case directory and metadata id differ: ${entry.name}`);
        return {
          id: metadata.id,
          title: metadata.title,
          status: metadata.status,
        };
      }),
  );
  return cases.toSorted((left, right) => left.id.localeCompare(right.id));
}

export async function readDesignCase(id: string, root?: string) {
  const directory = caseDirectory(id, root);
  const metadata = designCaseSchema.parse(
    JSON.parse(await readFile(join(directory, "case.json"), "utf8")),
  );
  if (metadata.id !== id) throw new Error(`Case directory and metadata id differ: ${id}`);
  return {
    ...metadata,
    directory,
    brief: await readFile(join(directory, "brief.md"), "utf8"),
    scenariosPath: join(directory, "scenarios.json"),
  };
}

export function appendReviewQuestions(brief: string, questions: string[]) {
  if (questions.length === 0) return brief;
  return `${brief.trimEnd()}\n\n---\n\nReview questions for this case:\n${questions.map((question) => `- ${question}`).join("\n")}`;
}
