import type { BuilderDraft } from "./builder-types";

export type {
  BuilderDraft,
  BuilderForm,
  BuildDestination,
  DeploymentProvider,
  ProviderField,
  StorageProvider,
} from "./builder-types";

const builderDraftStorageKey = (resumeKey: string) => `autograph-builder-draft:${resumeKey}`;
const builderDraftCache = new Map<
  string,
  { raw: string | null; resume: BuilderDraftResume | undefined }
>();

export type BuilderDraftResume = {
  draft: BuilderDraft;
  /** Revision acknowledged by the server before a provider navigation. */
  acknowledgedRevision?: number;
};

function parseBuilderDraft(value: string | null): BuilderDraftResume | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<BuilderDraft> & {
      draft?: Partial<BuilderDraft>;
      acknowledgedRevision?: unknown;
    };
    const draft = parsed.draft ?? parsed;
    if (
      draft.version !== 1 ||
      !draft.form ||
      (draft.focusOrigin !== "vercel" && draft.focusOrigin !== "github") ||
      !Array.isArray(draft.form.connections) ||
      !Array.isArray(draft.connectedConnections)
    )
      return undefined;
    const resume: BuilderDraftResume = {
      draft: {
        ...draft,
        form: {
          ...draft.form,
          buildDestination:
            draft.form.buildDestination === "web" ||
            draft.form.buildDestination === "codex" ||
            draft.form.buildDestination === "cursor"
              ? draft.form.buildDestination
              : "codex",
        },
        storageProvider: draft.storageProvider === null ? null : "github",
        deploymentProvider: draft.deploymentProvider === "vercel" ? "vercel" : null,
      } as BuilderDraft,
    };
    const { acknowledgedRevision } = parsed;
    if (
      typeof acknowledgedRevision === "number" &&
      Number.isSafeInteger(acknowledgedRevision) &&
      acknowledgedRevision > 0
    )
      resume.acknowledgedRevision = acknowledgedRevision;
    return resume;
  } catch {
    return undefined;
  }
}

export function readBuilderDraft(resumeKey: string) {
  return readBuilderDraftResume(resumeKey)?.draft;
}

export function readBuilderDraftResume(resumeKey: string) {
  const raw = sessionStorage.getItem(builderDraftStorageKey(resumeKey));
  const cached = builderDraftCache.get(resumeKey);
  if (cached?.raw === raw) return cached.resume;
  const resume = parseBuilderDraft(raw);
  builderDraftCache.set(resumeKey, { raw, resume });
  return resume;
}

export function persistBuilderDraft(
  resumeKey: string,
  draft: BuilderDraft,
  acknowledgedRevision?: number,
) {
  sessionStorage.setItem(
    builderDraftStorageKey(resumeKey),
    JSON.stringify({
      draft,
      ...(acknowledgedRevision === undefined ? {} : { acknowledgedRevision }),
    }),
  );
}

export function clearBuilderDraft(resumeKey: string) {
  sessionStorage.removeItem(builderDraftStorageKey(resumeKey));
}
