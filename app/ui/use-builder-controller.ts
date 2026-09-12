"use client";

import type {
  BuilderDraft,
  BuilderForm,
  DeploymentProvider,
  ProviderField,
  StorageProvider,
} from "./builder-types";

import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { FormEvent, SetStateAction } from "react";

import type { BuilderIntegrationState } from "@/lib/integrations/builder-state";
import { builderDraftFormSchema } from "@/lib/builder-drafts/contracts";
import type {
  BuilderDraftPageData,
  BuilderDraftRecord,
  SaveActiveBuilderDraftInput,
} from "@/lib/builder-drafts/contracts";
import { activeBuilderModelId } from "../../lib/integrations/active-model";
import { deriveBuilderAppId } from "../../lib/provisioning/names";
import type { ProviderConnectionNotice } from "../../lib/integrations/provider-connection-status";
import { createBuilderDraftOutbox } from "./builder-draft-outbox";
import { useBuilderDraftAutosave } from "./use-builder-draft-autosave";

import { comingSoonConnections } from "./builder-connections";
import type { ConnectionFlow } from "./builder-connections";
import {
  appNameFromBrief,
  defaultBrief,
  repositoryNameFromAppName,
  randomAppName,
  briefExamples,
} from "./builder-defaults";

const preferredModelId = activeBuilderModelId;

function subscribeToClientSnapshot() {
  return () => {
    // The client snapshot has no external subscription.
  };
}

export function useBuilderController({
  initialBrief,
  generatedNameSeed,
  onCreate,
  submissionPending = false,
  comingSoonEnabled,
  integrations,
  providerNotices,
  initialDraft,
  resumeKey,
  durableDraftId,
  durableDraftRevision = 0,
  durableDraftUpdatedAt,
  saveActiveBuilderDraftAction,
  loadActiveBuilderDraftAction,
}: {
  initialBrief: string;
  generatedNameSeed: string;
  onCreate: (checkpoint: { draftId: string; revision: number }, intentKey: string) => void;
  submissionPending?: boolean;
  comingSoonEnabled: boolean;
  integrations: BuilderIntegrationState;
  providerNotices: ProviderConnectionNotice[];
  initialDraft?: BuilderDraft;
  resumeKey?: string;
  durableDraftId?: string;
  durableDraftRevision?: number;
  durableDraftUpdatedAt?: string;
  saveActiveBuilderDraftAction?: (
    input: SaveActiveBuilderDraftInput,
  ) => Promise<{ draftId: string; revision: number; updatedAt: string }>;
  loadActiveBuilderDraftAction?: () => Promise<BuilderDraftPageData | undefined>;
}) {
  const router = useRouter();
  const teamOptions = integrations.vercel.scopes.map((scope) => ({
    value: scope.installationId,
    label: scope.displayName,
    detail: scope.plan === "unknown" ? "Connected" : scope.plan,
  }));
  const gitScopeOptions = integrations.github.scopes.map((scope) => ({
    value: scope.installationId,
    label: scope.accountLogin,
    detail: scope.accountType,
  }));
  const allModelOptions = integrations.models.entries
    .filter((model) => model.id === preferredModelId)
    .map((model) => ({
      value: model.id,
      label: model.name,
      detail: model.id,
    }));
  const defaultModel = allModelOptions[0]?.value ?? "";
  const effectiveInitialBrief = initialBrief.trim() ? initialBrief : defaultBrief;
  const initialAppName =
    appNameFromBrief(effectiveInitialBrief) || randomAppName(generatedNameSeed);
  const initialForm: BuilderForm = initialDraft
    ? {
        ...initialDraft.form,
        buildDestination: initialDraft.form.buildDestination ?? "codex",
      }
    : {
        appName: initialAppName,
        repository: repositoryNameFromAppName(initialAppName),
        brief: effectiveInitialBrief,
        privateRepository: true,
        buildDestination: "codex",
        connections: [],
        modelId: defaultModel,
      };
  const builderForm = useForm<BuilderForm>({
    defaultValues: initialForm,
    mode: "onChange",
    resolver: zodResolver(builderDraftFormSchema),
  });
  const form = useWatch({
    control: builderForm.control,
    defaultValue: initialForm,
  }) as BuilderForm;
  // RHF remains the form owner. This ref is only its synchronous mutation
  // mirror for action boundaries: a provider click can immediately follow an
  // input event while React is still publishing useWatch's render update.
  // Reading this mirror prevents a checkpoint from observing the prior field
  // value during that narrow window.
  const formSnapshot = useRef<BuilderForm>(initialForm);
  const localFormMutationVersion = useRef(0);
  const setForm = useCallback(
    (update: SetStateAction<BuilderForm>) => {
      localFormMutationVersion.current += 1;
      const { current } = formSnapshot;
      const next = typeof update === "function" ? update(current) : update;
      formSnapshot.current = next;
      for (const field of Object.keys(next) as (keyof BuilderForm)[]) {
        // RHF publishes each setValue to useWatch independently. Replaying an
        // unchanged field from an older composite snapshot can otherwise
        // arrive after a later input event and overwrite it (for example, a
        // generated name replacing a manually edited name before OAuth).
        if (Object.is(current[field], next[field])) {
          continue;
        }
        builderForm.setValue(field, next[field], {
          shouldDirty: true,
          shouldValidate: true,
        });
      }
    },
    [builderForm],
  );
  const appNameEditedByUser = useRef(initialDraft?.appNameEditedByUser ?? false);
  // Keep the provenance of an inferred name separate from the persisted
  // marker. A streamed action acknowledgement can briefly replay an older
  // marker while RHF already holds a user-entered name; that acknowledgement
  // must not turn the next brief edit into an instruction to replace it.
  const generatedAppName = useRef<string | undefined>(
    initialDraft?.appNameEditedByUser ? undefined : initialForm.appName,
  );
  const repositoryEditedByUser = useRef(initialDraft?.repositoryEditedByUser ?? false);
  const [initialActiveDraftId] = useState(() => resumeKey ?? durableDraftId ?? crypto.randomUUID());
  const activeDraftId = useRef(initialActiveDraftId);
  const resumedVercelConnection = providerNotices.some(
    (notice) => notice.provider === "vercel" && notice.status === "connected",
  );
  const resumedGitHubConnection = providerNotices.some(
    (notice) => notice.provider === "github" && notice.status === "connected",
  );
  const [team, setTeam] = useState(
    resumedVercelConnection
      ? (teamOptions[0]?.value ?? "")
      : (initialDraft?.team ?? teamOptions[0]?.value ?? ""),
  );
  const [gitScope, setGitScope] = useState(
    resumedGitHubConnection
      ? (gitScopeOptions[0]?.value ?? "")
      : (initialDraft?.gitScope ?? gitScopeOptions[0]?.value ?? ""),
  );
  const [model, setModel] = useState(defaultModel);
  const [zdrOnly, setZdrOnly] = useState(initialDraft?.zdrOnly ?? false);
  const [showMoreConnections, setShowMoreConnections] = useState(
    initialDraft?.showMoreConnections ?? false,
  );
  const [search, setSearch] = useState(initialDraft?.search ?? "");
  const [connectionFlow, setConnectionFlow] = useState<ConnectionFlow | null>(null);
  const clientHydrated = useSyncExternalStore(
    subscribeToClientSnapshot,
    () => true,
    () => false,
  );
  const [draftRecoveryComplete, setDraftRecoveryComplete] = useState(false);
  const checkpointing = useRef(false);
  const [preparingSubmission, setPreparingSubmission] = useState(false);
  const interactive = clientHydrated && draftRecoveryComplete;
  const [connectedConnections, setConnectedConnections] = useState<string[]>(
    initialDraft?.connectedConnections ?? [],
  );
  const [storageProvider, setStorageProvider] = useState<StorageProvider | null>(
    initialDraft?.storageProvider === null ? null : "github",
  );
  const [deploymentProvider, setDeploymentProvider] = useState<DeploymentProvider | null>(
    initialDraft?.deploymentProvider === "vercel" ? "vercel" : null,
  );
  const draftRevision = useRef(durableDraftRevision);
  const draftUpdatedAt = useRef(durableDraftUpdatedAt);
  // Server Actions can overlap at the React/RSC boundary even though the
  // autosave transport serializes their database writes: the next action may
  // have started by the time an earlier RSC acknowledgement arrives. Track
  // every in-flight base revision, rather than one mutable slot, so an older
  // completion cannot clear the newer action's hydration guard.
  const pendingActionExpectedRevisions = useRef(new Set<number>());
  // The RSC payload for a local action can arrive after the action promise has
  // settled. Remember the local edit version that initiated each revision so a
  // delayed acknowledgement cannot replace a newer RHF edit. This only applies
  // to this mounted builder; a provider-return route still hydrates directly
  // from its server-rendered draft.
  const localActionMutationVersions = useRef(new Map<number, number>());
  const focusOrigin = useRef<ProviderField>(initialDraft?.focusOrigin ?? "github");
  const draftOutbox = useMemo(
    () =>
      createBuilderDraftOutbox<BuilderDraft>({
        key: `active:${initialActiveDraftId}`,
      }),
    [initialActiveDraftId],
  );
  type ServerSaveState =
    | {
        mutationId: string;
        saved: { draftId: string; revision: number; updatedAt: string };
      }
    | { mutationId: string; error: string }
    | undefined;
  const [serverSaveState, dispatchServerSave] = useActionState(
    async (
      _previous: ServerSaveState,
      input: SaveActiveBuilderDraftInput,
    ): Promise<ServerSaveState> => {
      if (!saveActiveBuilderDraftAction) {
        return {
          mutationId: input.clientMutationId,
          error: "builder-draft-action-unavailable",
        };
      }
      try {
        return {
          mutationId: input.clientMutationId,
          saved: await saveActiveBuilderDraftAction(input),
        };
      } catch (error) {
        return {
          mutationId: input.clientMutationId,
          error: error instanceof Error ? error.message : "builder-draft-save-failed",
        };
      }
    },
    undefined,
  );
  const serverSaveWaiters = useRef(
    new Map<
      string,
      {
        resolve: (saved: { draftId: string; revision: number; updatedAt: string }) => void;
        reject: (error: Error) => void;
      }
    >(),
  );
  useEffect(() => {
    if (!serverSaveState) {
      return;
    }
    const waiter = serverSaveWaiters.current.get(serverSaveState.mutationId);
    if (!waiter) {
      return;
    }
    serverSaveWaiters.current.delete(serverSaveState.mutationId);
    if ("saved" in serverSaveState) {
      waiter.resolve(serverSaveState.saved);
    } else {
      waiter.reject(new Error(serverSaveState.error));
    }
  }, [serverSaveState]);
  useEffect(
    () => () => {
      for (const waiter of serverSaveWaiters.current.values()) {
        waiter.reject(new Error("builder-draft-unmounted"));
      }
      serverSaveWaiters.current.clear();
    },
    [],
  );
  const requestServerSave = useCallback(
    (input: SaveActiveBuilderDraftInput) => {
      const acknowledgement = Promise.withResolvers<{
        draftId: string;
        revision: number;
        updatedAt: string;
      }>();
      serverSaveWaiters.current.set(input.clientMutationId, acknowledgement);
      // `useActionState` gives React ownership of dispatch and result state.
      // This transition launches the action; the returned promise only waits
      // for the matching state acknowledgement so the autosave outbox can
      // clear exactly the mutation the server completed.
      startTransition(() => dispatchServerSave(input));
      return acknowledgement.promise;
    },
    [dispatchServerSave],
  );
  const saveDraft = useCallback(
    async ({
      mutationId,
      snapshot,
      keepalive,
    }: {
      mutationId: string;
      snapshot: BuilderDraft;
      keepalive: boolean;
    }) => {
      const input = {
        version: 1 as const,
        draftId: activeDraftId.current,
        expectedRevision: draftRevision.current,
        clientMutationId: mutationId,
        record: {
          version: 1 as const,
          draft: snapshot,
        } satisfies BuilderDraftRecord,
      };
      if (!keepalive) {
        pendingActionExpectedRevisions.current.add(input.expectedRevision);
        localActionMutationVersions.current.set(
          input.expectedRevision + 1,
          localFormMutationVersion.current,
        );
      }
      try {
        const saved = keepalive
          ? await fetch("/api/builder/draft", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input),
              keepalive: true,
            }).then(async (response) => {
              if (!response.ok) {
                throw new Error("builder-draft-save-failed");
              }
              return (await response.json()) as {
                draftId: string;
                revision: number;
                updatedAt: string;
              };
            })
          : saveActiveBuilderDraftAction
            ? await requestServerSave(input)
            : await Promise.reject(new Error("builder-draft-action-unavailable"));
        activeDraftId.current = saved.draftId;
        draftRevision.current = saved.revision;
        draftUpdatedAt.current = saved.updatedAt;
        // Remove only the anonymous brief this mounted session has claimed,
        // and only after durable acknowledgement. Never erase a newer tab's brief.
        if (initialBrief) {
          try {
            if (sessionStorage.getItem("autograph-app-brief") === initialBrief) {
              sessionStorage.removeItem("autograph-app-brief");
            }
          } catch {
            // The acknowledged server draft remains authoritative without browser storage.
          }
        }
        return {
          mutationId,
          revision: saved.revision,
          savedAt: saved.updatedAt,
        };
      } finally {
        if (!keepalive) {
          pendingActionExpectedRevisions.current.delete(input.expectedRevision);
        }
      }
    },
    [initialBrief, requestServerSave, saveActiveBuilderDraftAction],
  );
  const autosave = useBuilderDraftAutosave({
    outbox: draftOutbox,
    save: saveDraft,
    debounceMs: 500,
    initialRevision: durableDraftRevision ?? 0,
  });
  const {
    discardPending: discardPendingDraft,
    discardSupersededByRemoteRevision,
    restorePending,
    resumePending,
    schedule: scheduleAutosave,
  } = autosave;
  const [draftSaveError, setDraftSaveError] = useState("");
  const [draftSyncNotice, setDraftSyncNotice] = useState("");
  // Do not infer a user edit from React's post-hydration renders. Apart from
  // creating needless writes, an initial default-draft save can outlive a
  // closing tab and race a later authenticated visit. Track the last snapshot
  // we intentionally queued instead; every actual field or local-control
  // change produces a distinct snapshot.
  const autosaveSnapshotFingerprint = useRef<string | undefined>(
    initialDraft ? JSON.stringify(initialDraft) : undefined,
  );
  const visibleProviderNotices = providerNotices.filter(
    (notice) =>
      !(
        notice.status === "failed" &&
        (notice.reason === "configuration-unavailable" || notice.provider === "github")
      ),
  );
  const draftSnapshot = useCallback(
    (origin = focusOrigin.current): BuilderDraft => {
      // React Hook Form is the live form authority. `useWatch` deliberately
      // renders later, and the convenience mirror can be stale while React
      // processes an input event. Read RHF synchronously at every durable
      // boundary so autosave, provider redirects, and handoff creation all
      // checkpoint exactly the values the user just entered.
      const currentForm = builderForm.getValues();
      formSnapshot.current = currentForm;
      return {
        version: 1,
        form: currentForm,
        team,
        gitScope,
        model,
        zdrOnly,
        showMoreConnections,
        search,
        connectedConnections,
        storageProvider,
        deploymentProvider,
        focusOrigin: origin,
        appNameEditedByUser: appNameEditedByUser.current,
        repositoryEditedByUser: repositoryEditedByUser.current,
      };
    },
    [
      connectedConnections,
      builderForm,
      deploymentProvider,
      gitScope,
      model,
      search,
      showMoreConnections,
      storageProvider,
      team,
      zdrOnly,
    ],
  );
  const applyAuthoritativeDraft = useCallback(
    async (
      remote: {
        draftId: string;
        revision: number;
        updatedAt: string;
        record: BuilderDraftRecord;
      },
      expectedLocalMutationVersion?: number,
    ) => {
      // A polling request can begin before a user edit and return a server
      // snapshot that predates that edit. It is not an incoming concurrent
      // draft and must never reset the newer RHF state.
      if (
        expectedLocalMutationVersion !== undefined &&
        localFormMutationVersion.current !== expectedLocalMutationVersion
      ) {
        return;
      }
      if (remote.revision <= draftRevision.current) {
        return;
      }
      await discardSupersededByRemoteRevision(remote.revision);
      // A newer server snapshot or save acknowledgement can settle while
      // device outbox I/O is pending. Never move the applied revision backward.
      if (remote.revision <= draftRevision.current) {
        return;
      }
      if (
        expectedLocalMutationVersion !== undefined &&
        localFormMutationVersion.current !== expectedLocalMutationVersion
      ) {
        return;
      }
      draftRevision.current = remote.revision;
      draftUpdatedAt.current = remote.updatedAt;
      activeDraftId.current = remote.draftId;
      const snapshot = remote.record.draft;
      formSnapshot.current = snapshot.form;
      builderForm.reset(snapshot.form);
      setTeam(snapshot.team);
      setGitScope(snapshot.gitScope);
      setModel(snapshot.model);
      setZdrOnly(snapshot.zdrOnly);
      setShowMoreConnections(snapshot.showMoreConnections);
      setSearch(snapshot.search);
      setConnectedConnections(snapshot.connectedConnections);
      setStorageProvider(snapshot.storageProvider ?? null);
      setDeploymentProvider(snapshot.deploymentProvider ?? null);
      focusOrigin.current = snapshot.focusOrigin;
      appNameEditedByUser.current = snapshot.appNameEditedByUser;
      generatedAppName.current = snapshot.appNameEditedByUser ? undefined : snapshot.form.appName;
      repositoryEditedByUser.current = snapshot.repositoryEditedByUser;
      autosaveSnapshotFingerprint.current = JSON.stringify(snapshot);
      setDraftSyncNotice("Updated from another device");
    },
    [
      builderForm,
      discardSupersededByRemoteRevision,
      setConnectedConnections,
      setDeploymentProvider,
      setDraftSyncNotice,
      setGitScope,
      setModel,
      setSearch,
      setShowMoreConnections,
      setStorageProvider,
      setTeam,
      setZdrOnly,
    ],
  );
  const modelOptions = zdrOnly
    ? allModelOptions.filter((option) =>
        integrations.models.entries.some(
          (modelEntry) => modelEntry.id === option.value && modelEntry.zdr === "all",
        ),
      )
    : allModelOptions;
  let validAppId = false;
  try {
    deriveBuilderAppId(form.appName);
    validAppId = true;
  } catch {
    // Invalid app names simply keep submission disabled.
  }
  const canSubmit = Boolean(
    form.brief.trim() &&
    (!form.appName.trim() || validAppId) &&
    (form.buildDestination !== "web" || (integrations.models.status === "ready" && model)),
  );
  const submitGuidance =
    form.appName.trim() && !validAppId
      ? "Use an app name that can form a lowercase, URL-safe app ID."
      : form.brief.trim()
        ? form.buildDestination === "web" && (integrations.models.status !== "ready" || !model)
          ? "Choose an available model to continue."
          : undefined
        : "Add an app brief to continue.";
  const updateBrief = (brief: string) => {
    setForm((current) => {
      // `formSnapshot` is updated atomically by every builder field handler.
      // Do not read RHF's per-field store here: while an RSC acknowledgement
      // is hydrating it can briefly combine the latest name with the incoming
      // brief. That transient composite must never become a durable generated
      // name on an OAuth-return checkpoint.
      const currentAppName = current.appName;
      // Preserve a name that RHF knows was entered directly, even if an older
      // Server Action/RSC acknowledgement has not yet caught up with the
      // persisted ownership marker. A newer authoritative remote revision
      // updates generatedAppName above and is still allowed to replace it.
      if (
        appNameEditedByUser.current ||
        (generatedAppName.current !== undefined && generatedAppName.current !== currentAppName)
      ) {
        return { ...current, appName: currentAppName, brief };
      }
      const appName = appNameFromBrief(brief) || randomAppName(generatedNameSeed);
      generatedAppName.current = appName;
      return {
        ...current,
        brief,
        appName,
        repository: repositoryEditedByUser.current
          ? current.repository
          : repositoryNameFromAppName(appName),
      };
    });
  };
  const addConnection = (name: string) => {
    if (comingSoonConnections.has(name)) {
      return;
    }
    setForm((current) => ({
      ...current,
      connections: current.connections.includes(name)
        ? current.connections
        : [...current.connections, name],
    }));
  };
  const removeConnection = (name: string) => {
    setForm((current) => ({
      ...current,
      connections: current.connections.filter((item) => item !== name),
    }));
    setConnectedConnections((current) => current.filter((item) => item !== name));
  };
  const completeConnection = () => {
    if (!connectionFlow) {
      return;
    }
    setConnectedConnections((current) =>
      current.includes(connectionFlow.name) ? current : [...current, connectionFlow.name],
    );
    setConnectionFlow(null);
  };
  useEffect(() => {
    if (!interactive) {
      return;
    }
    const id = resumedVercelConnection
      ? "vercel-team"
      : resumedGitHubConnection
        ? "git-scope"
        : initialDraft?.focusOrigin === "vercel"
          ? "vercel-team"
          : initialDraft
            ? "git-scope"
            : undefined;
    if (!id) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`#${id}`)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialDraft, interactive, resumedGitHubConnection, resumedVercelConnection]);
  useEffect(() => {
    let disposed = false;
    const recoveryStartVersion = localFormMutationVersion.current;
    // Recovery updates are intentionally scheduled without blocking the effect.
    // oxlint-disable promise/prefer-await-to-callbacks
    // oxlint-disable promise/prefer-await-to-then
    // oxlint-disable-next-line promise/prefer-await-to-then
    void restorePending()
      .then((entry) => {
        if (disposed || !entry) {
          return;
        }
        // IndexedDB can resolve after the user has already started editing the
        // hydrated form. Never let that older recovery snapshot replace those
        // edits or reset the user-edited field markers. The new local snapshot
        // will be queued by the normal autosave effect.
        if (localFormMutationVersion.current !== recoveryStartVersion) {
          void discardPendingDraft();
          return;
        }
        // A recovery outbox is only useful when it is newer than the server
        // snapshot rendered for this visit. Server revisions remain canonical.
        if (draftUpdatedAt.current && entry.createdAt <= Date.parse(draftUpdatedAt.current)) {
          void discardPendingDraft();
          return;
        }
        const { snapshot } = entry;
        formSnapshot.current = snapshot.form;
        builderForm.reset(snapshot.form);
        setTeam(snapshot.team);
        setGitScope(snapshot.gitScope);
        setModel(snapshot.model);
        setZdrOnly(snapshot.zdrOnly);
        setShowMoreConnections(snapshot.showMoreConnections);
        setSearch(snapshot.search);
        setConnectedConnections(snapshot.connectedConnections);
        setStorageProvider(snapshot.storageProvider ?? null);
        setDeploymentProvider(snapshot.deploymentProvider ?? null);
        focusOrigin.current = snapshot.focusOrigin;
        appNameEditedByUser.current = snapshot.appNameEditedByUser;
        generatedAppName.current = snapshot.appNameEditedByUser ? undefined : snapshot.form.appName;
        repositoryEditedByUser.current = snapshot.repositoryEditedByUser;
        autosaveSnapshotFingerprint.current = JSON.stringify(snapshot);
        if (!disposed) {
          void resumePending();
        }
      })
      // Complete the recovery indicator for both success and failure.
      // oxlint-disable-next-line promise/prefer-await-to-then
      .finally(() => {
        if (!disposed) {
          setDraftRecoveryComplete(true);
        }
      });
    // oxlint-enable promise/prefer-await-to-callbacks
    // oxlint-enable promise/prefer-await-to-then
    return () => {
      disposed = true;
    };
  }, [builderForm, discardPendingDraft, restorePending, resumePending]);
  useEffect(() => {
    let disposed = false;
    let wasHidden = document.visibilityState === "hidden";
    const checkForServerDraft = async () => {
      if (document.visibilityState === "hidden" || !navigator.onLine) {
        return;
      }
      const localMutationVersion = localFormMutationVersion.current;
      // A completed foreground action can become visible to this read before
      // its acknowledgement advances draftRevision. Do not reinterpret that
      // device-local save as a remote revision and replace edits made while
      // the action was in flight.
      if (pendingActionExpectedRevisions.current.size > 0) {
        return;
      }
      try {
        if (!loadActiveBuilderDraftAction) {
          return;
        }
        const remote = await loadActiveBuilderDraftAction();
        if (
          disposed ||
          !remote ||
          pendingActionExpectedRevisions.current.size > 0 ||
          localFormMutationVersion.current !== localMutationVersion
        ) {
          return;
        }
        await applyAuthoritativeDraft(remote, localMutationVersion);
      } catch {
        // Autosave owns retry/error presentation; sync polling stays quiet.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "hidden") {
        wasHidden = true;
        return;
      }
      // Browsers can emit an initial visible event while the builder hydrates.
      // The server-rendered snapshot is already authoritative for that first
      // paint; only refresh after this document has actually been backgrounded.
      if (wasHidden) {
        void checkForServerDraft();
      }
    };
    const timer = setInterval(() => {
      checkForServerDraft();
    }, 10_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [applyAuthoritativeDraft, loadActiveBuilderDraftAction]);
  useEffect(() => {
    if (durableDraftRevision <= draftRevision.current) {
      return;
    }
    if (!initialDraft || !durableDraftId || !durableDraftUpdatedAt) {
      return;
    }
    const actionMutationVersion = localActionMutationVersions.current.get(durableDraftRevision);
    if (pendingActionExpectedRevisions.current.has(durableDraftRevision - 1)) {
      activeDraftId.current = durableDraftId;
      draftRevision.current = durableDraftRevision;
      draftUpdatedAt.current = durableDraftUpdatedAt;
      return;
    }
    if (
      actionMutationVersion !== undefined &&
      localFormMutationVersion.current !== actionMutationVersion
    ) {
      activeDraftId.current = durableDraftId;
      draftRevision.current = durableDraftRevision;
      draftUpdatedAt.current = durableDraftUpdatedAt;
      localActionMutationVersions.current.delete(durableDraftRevision);
      return;
    }
    if (actionMutationVersion !== undefined) {
      localActionMutationVersions.current.delete(durableDraftRevision);
    }
    void applyAuthoritativeDraft({
      draftId: durableDraftId,
      revision: durableDraftRevision,
      updatedAt: durableDraftUpdatedAt,
      record: { version: 1, draft: initialDraft },
    });
  }, [
    applyAuthoritativeDraft,
    durableDraftId,
    durableDraftRevision,
    durableDraftUpdatedAt,
    initialDraft,
  ]);
  useEffect(() => {
    if (!draftSyncNotice) {
      return;
    }
    const timer = window.setTimeout(() => setDraftSyncNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [draftSyncNotice]);
  useEffect(() => {
    const snapshot = draftSnapshot();
    const fingerprint = JSON.stringify(snapshot);
    if (autosaveSnapshotFingerprint.current === undefined) {
      // Establish the hydrated server/form state as the baseline. The first
      // deliberate edit (including a non-RHF builder control) will differ.
      autosaveSnapshotFingerprint.current = fingerprint;
      if (initialBrief && !initialDraft) {
        scheduleAutosave(snapshot);
      }
      return;
    }
    if (autosaveSnapshotFingerprint.current === fingerprint) {
      return;
    }
    autosaveSnapshotFingerprint.current = fingerprint;
    scheduleAutosave(snapshot);
  }, [draftSnapshot, form, initialBrief, initialDraft, scheduleAutosave]);
  const beginProviderConnection = async (provider: ProviderField) => {
    focusOrigin.current = provider;
    const draft = draftSnapshot(provider);
    autosave.schedule(draft);
    await autosave.flush();
    if (await autosave.restorePending()) {
      setDraftSaveError("We couldn’t save your form. Retry saving to connect a provider.");
      return;
    }
    setDraftSaveError("");
    // The flush includes edits queued while the checkpoint was in flight.
    // Return hydration reads that server draft; never stamp the earlier click
    // snapshot with the final revision and restore it over the newer save.
    // The service owns the one active draft and may acknowledge a canonical
    // ID different from the optimistic local ID. Capture it only after the
    // Server Action checkpoint has completed so a provider return can never
    // target a stale, non-authoritative draft.
    router.push(`/${provider}/installations?returnTo=%2F&resume=${activeDraftId.current}`);
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (checkpointing.current || submissionPending || !canSubmit) {
      return;
    }
    checkpointing.current = true;
    setPreparingSubmission(true);
    try {
      if (!(await builderForm.trigger())) {
        return;
      }
      // `useWatch` intentionally updates on React's render cadence. A click
      // immediately after the final input event can therefore observe the
      // prior rendered value here. Read RHF synchronously at this action
      // boundary so the durable handoff cannot be created from a stale
      // generated name (or any other last-keystroke value).
      const currentForm = builderForm.getValues();
      const appName =
        currentForm.appName.trim() || appNameFromBrief(currentForm.brief) || randomAppName();
      const submissionForm: BuilderForm = {
        ...currentForm,
        appName,
        repository: currentForm.repository.trim() || repositoryNameFromAppName(appName),
        githubInstallationId: storageProvider === "github" && gitScope ? gitScope : undefined,
        vercelInstallationId: deploymentProvider === "vercel" && team ? team : undefined,
        modelId: preferredModelId,
      };
      setForm(submissionForm);
      autosave.schedule({ ...draftSnapshot(), form: submissionForm });
      await autosave.flush();
      if (await autosave.restorePending()) {
        setDraftSaveError("We couldn’t save your form. Retry saving before creating your app.");
        return;
      }
      setDraftSaveError("");
      onCreate(
        { draftId: activeDraftId.current, revision: draftRevision.current },
        JSON.stringify(builderForm.getValues()),
      );
    } finally {
      checkpointing.current = false;
      setPreparingSubmission(false);
    }
  }

  return {
    form,
    builderForm,
    appNameEditedByUser,
    generatedAppName,
    repositoryEditedByUser,
    setForm,
    updateBrief,
    comingSoonEnabled,
    integrations,
    model,
    modelOptions,
    zdrOnly,
    setModel,
    setZdrOnly,
    router,
    storageProvider,
    gitScope,
    gitScopeOptions,
    setStorageProvider,
    setGitScope,
    beginProviderConnection,
    deploymentProvider,
    team,
    teamOptions,
    setDeploymentProvider,
    setTeam,
    connectedConnections,
    search,
    showMoreConnections,
    addConnection,
    removeConnection,
    setSearch,
    setShowMoreConnections,
    setConnectionFlow,
    canSubmit,
    submitGuidance,
    visibleProviderNotices,
    draftSaveError,
    draftSyncNotice,
    autosave,
    setDraftSaveError,
    submissionPending,
    preparingSubmission,
    submit,
    interactive,
    connectionFlow,
    completeConnection,
    briefExamples,
    repositoryNameFromAppName,
  };
}
