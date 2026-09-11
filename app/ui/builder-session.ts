import type { BuilderProvisionResponse } from "@/lib/provisioning/contracts";

import type {
  BuilderDraft,
  BuilderForm,
  BuilderHandoffReference,
} from "./builder-types";

export type {
  BuilderDraft,
  BuilderForm,
  BuilderHandoffReference,
  BuildDestination,
  DeploymentProvider,
  ProviderField,
  StorageProvider,
} from "./builder-types";

export interface ActiveProvisioning {
  version: 1;
  requestId: string;
  handoffCreationRequestId: string;
  form: BuilderForm;
  phase: "handoff" | "ready";
  provisioning?: BuilderProvisionResponse;
  handoff?: BuilderHandoffReference;
}

export const activeProvisioningStorageKey =
  "autograph-builder-active-provisioning";

const builderDraftStorageKey = (resumeKey: string) =>
  `autograph-builder-draft:${resumeKey}`;
const builderDraftCache = new Map<
  string,
  { raw: string | null; resume: BuilderDraftResume | undefined }
>();
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface BuilderDraftResume {
  draft: BuilderDraft;
  /** Revision acknowledged by the server before a provider navigation. */
  acknowledgedRevision?: number;
}

function parseBuilderDraft(
  value: string | null
): BuilderDraftResume | undefined {
  if (!value) {
    return undefined;
  }
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
    ) {
      return undefined;
    }
    const resume: BuilderDraftResume = {
      draft: {
        ...draft,
        deploymentProvider:
          draft.deploymentProvider === "vercel" ? "vercel" : null,
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
      } as BuilderDraft,
    };
    const { acknowledgedRevision } = parsed;
    if (
      typeof acknowledgedRevision === "number" &&
      Number.isSafeInteger(acknowledgedRevision) &&
      acknowledgedRevision > 0
    ) {
      resume.acknowledgedRevision = acknowledgedRevision;
    }
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
  if (cached?.raw === raw) {
    return cached.resume;
  }
  const resume = parseBuilderDraft(raw);
  builderDraftCache.set(resumeKey, { raw, resume });
  return resume;
}

export function persistBuilderDraft(
  resumeKey: string,
  draft: BuilderDraft,
  acknowledgedRevision?: number
) {
  sessionStorage.setItem(
    builderDraftStorageKey(resumeKey),
    JSON.stringify({
      draft,
      ...(acknowledgedRevision === undefined ? {} : { acknowledgedRevision }),
    })
  );
}

export function clearBuilderDraft(resumeKey: string) {
  sessionStorage.removeItem(builderDraftStorageKey(resumeKey));
}

export function parseActiveProvisioning(value: string | null) {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as Partial<ActiveProvisioning>;
    const phase =
      parsed.phase === "handoff" || parsed.phase === "ready"
        ? parsed.phase
        : undefined;
    if (
      parsed.version !== 1 ||
      !parsed.requestId?.match(uuidPattern) ||
      !parsed.handoffCreationRequestId?.match(uuidPattern) ||
      !parsed.form ||
      phase === undefined ||
      typeof parsed.form.appName !== "string" ||
      typeof parsed.form.repository !== "string" ||
      typeof parsed.form.brief !== "string" ||
      typeof parsed.form.privateRepository !== "boolean" ||
      !["web", "codex", "cursor"].includes(parsed.form.buildDestination) ||
      !Array.isArray(parsed.form.connections) ||
      typeof parsed.form.modelId !== "string"
    ) {
      return undefined;
    }
    const { provisioning } = parsed;
    const { handoff } = parsed;
    if (
      phase === "ready" &&
      (!provisioning ||
        provisioning.version !== 1 ||
        provisioning.requestId !== parsed.requestId ||
        typeof provisioning.requestDigest !== "string" ||
        typeof provisioning.appId !== "string" ||
        !["pending", "settled"].includes(provisioning.status) ||
        typeof provisioning.github !== "object" ||
        typeof provisioning.vercel !== "object" ||
        typeof provisioning.updatedAt !== "string" ||
        handoff?.version !== 1 ||
        !uuidPattern.test(handoff.handoffId) ||
        Number.isNaN(Date.parse(handoff.expiresAt)))
    ) {
      return undefined;
    }
    return {
      form: parsed.form,
      handoffCreationRequestId: parsed.handoffCreationRequestId,
      phase,
      requestId: parsed.requestId,
      version: 1,
      ...(provisioning ? { provisioning } : {}),
      ...(handoff ? { handoff } : {}),
    } satisfies ActiveProvisioning;
  } catch {
    return;
  }
}

export function persistActiveProvisioning(value: ActiveProvisioning) {
  sessionStorage.setItem(activeProvisioningStorageKey, JSON.stringify(value));
}

export function clearActiveProvisioning() {
  sessionStorage.removeItem(activeProvisioningStorageKey);
}
