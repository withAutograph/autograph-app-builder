import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const caseId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const designCaseSchema = z.object({
  evidence: z.array(
    z.object({
      path: z.string().min(1),
      repo: z.string().min(1),
      status: z.string().min(1),
    }),
  ),
  id: caseId,
  notes: z.string(),
  outcomes: z.array(z.string().min(1)),
  reviewQuestions: z.array(z.string().min(1)),
  status: z.string().min(1),
  title: z.string().min(1),
});

export type DesignCase = z.infer<typeof designCaseSchema>;
export type ListedDesignCase = Pick<DesignCase, "id" | "title" | "status">;

export function designCasesRoot(root = "docs/design-quality-cases") {
  return path.resolve(root);
}

function caseDirectory(id: string, root?: string) {
  return path.join(designCasesRoot(root), caseId.parse(id));
}

export async function listDesignCases(root?: string): Promise<ListedDesignCase[]> {
  const base = designCasesRoot(root);
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) {
      return [];
    }
    throw error;
  }
  const cases = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && caseId.safeParse(entry.name).success)
      .map(async (entry) => {
        const metadata = designCaseSchema.parse(
          JSON.parse(await readFile(path.join(base, entry.name, "case.json"), "utf-8")),
        );
        if (metadata.id !== entry.name) {
          throw new Error(`Case directory and metadata id differ: ${entry.name}`);
        }
        return {
          id: metadata.id,
          status: metadata.status,
          title: metadata.title,
        };
      }),
  );
  return cases.toSorted((left, right) => left.id.localeCompare(right.id));
}

export async function readDesignCase(id: string, root?: string) {
  const directory = caseDirectory(id, root);
  const metadata = designCaseSchema.parse(
    JSON.parse(await readFile(path.join(directory, "case.json"), "utf-8")),
  );
  if (metadata.id !== id) {
    throw new Error(`Case directory and metadata id differ: ${id}`);
  }
  return {
    ...metadata,
    brief: await readFile(path.join(directory, "brief.md"), "utf-8"),
    directory,
    scenariosPath: path.join(directory, "scenarios.json"),
  };
}

export function appendReviewQuestions(brief: string, questions: string[]) {
  if (questions.length === 0) {
    return brief;
  }
  const questionList = questions.map((question) => `- ${question}`).join("\n");
  return [brief.trimEnd(), "---", "Review questions for this case:", questionList].join("\n\n");
}
