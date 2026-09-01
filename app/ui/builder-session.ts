import type { BuilderProvisionResponse } from "@/lib/provisioning/contracts";

export type BuildDestination = "web" | "codex" | "cursor";

export type BuilderHandoffReference = {
  version: 1;
  handoffId: string;
  expiresAt: string;
};

export type BuilderForm = {
  appName: string;
  repository: string;
  brief: string;
  privateRepository: boolean;
  buildDestination: BuildDestination;
  connections: string[];
  vercelInstallationId?: string;
  githubInstallationId?: string;
  modelId: string;
};

export type BuilderDraft = {
  version: 1;
  form: BuilderForm;
  team: string;
  gitScope: string;
  model: string;
  zdrOnly: boolean;
  showMoreConnections: boolean;
  search: string;
  connectedConnections: string[];
  storageProvider?: StorageProvider | null;
  deploymentProvider?: DeploymentProvider | null;
  focusOrigin: ProviderField;
  appNameEditedByUser: boolean;
  repositoryEditedByUser: boolean;
};

export type ProviderField = "vercel" | "github";
export type StorageProvider = "github" | "gitlab" | "bitbucket";
export type DeploymentProvider = "vercel" | "netlify" | "cloudflare";

export type ActiveProvisioning = {
  version: 1;
  requestId: string;
  handoffCreationRequestId: string;
  form: BuilderForm;
  phase: "handoff" | "ready";
  provisioning?: BuilderProvisionResponse;
  handoff?: BuilderHandoffReference;
};

export const activeProvisioningStorageKey =
  "autograph-builder-active-provisioning";

const builderDraftStorageKey = (resumeKey: string) =>
  `autograph-builder-draft:${resumeKey}`;
const builderDraftCache = new Map<
  string,
  { raw: string | null; draft: BuilderDraft | undefined }
>();
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function parseBuilderDraft(value: string | null): BuilderDraft | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<BuilderDraft>;
    if (
      parsed.version !== 1 ||
      !parsed.form ||
      (parsed.focusOrigin !== "vercel" && parsed.focusOrigin !== "github") ||
      !Array.isArray(parsed.form.connections) ||
      !Array.isArray(parsed.connectedConnections)
    )
      return undefined;
    return {
      ...parsed,
      form: {
        ...parsed.form,
        buildDestination:
          parsed.form.buildDestination === "web" ||
          parsed.form.buildDestination === "codex" ||
          parsed.form.buildDestination === "cursor"
            ? parsed.form.buildDestination
            : "codex",
      },
      storageProvider: parsed.storageProvider === null ? null : "github",
      deploymentProvider:
        parsed.deploymentProvider === "vercel" ? "vercel" : null,
    } as BuilderDraft;
  } catch {
    return undefined;
  }
}

export function readBuilderDraft(resumeKey: string) {
  const raw = sessionStorage.getItem(builderDraftStorageKey(resumeKey));
  const cached = builderDraftCache.get(resumeKey);
  if (cached?.raw === raw) return cached.draft;
  const draft = parseBuilderDraft(raw);
  builderDraftCache.set(resumeKey, { raw, draft });
  return draft;
}

export function persistBuilderDraft(resumeKey: string, draft: BuilderDraft) {
  sessionStorage.setItem(
    builderDraftStorageKey(resumeKey),
    JSON.stringify(draft),
  );
}

export function clearBuilderDraft(resumeKey: string) {
  sessionStorage.removeItem(builderDraftStorageKey(resumeKey));
}

export function parseActiveProvisioning(value: string | null) {
  if (!value) return undefined;
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
    )
      return undefined;
    const provisioning = parsed.provisioning;
    const handoff = parsed.handoff;
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
        !handoff.handoffId.match(uuidPattern) ||
        Number.isNaN(Date.parse(handoff.expiresAt)))
    )
      return undefined;
    return {
      version: 1,
      requestId: parsed.requestId,
      handoffCreationRequestId: parsed.handoffCreationRequestId,
      form: parsed.form,
      phase,
      ...(provisioning ? { provisioning } : {}),
      ...(handoff ? { handoff } : {}),
    } satisfies ActiveProvisioning;
  } catch {
    return undefined;
  }
}

export function persistActiveProvisioning(value: ActiveProvisioning) {
  sessionStorage.setItem(activeProvisioningStorageKey, JSON.stringify(value));
}

export function clearActiveProvisioning() {
  sessionStorage.removeItem(activeProvisioningStorageKey);
}
