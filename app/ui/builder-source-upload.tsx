"use client";
import { sourceCandidateReferenceSchema } from "@/lib/handoff/application-source-contract";
import { startTransition, useActionState, useState, useRef } from "react";
import {
  beginBuilderSourceUpload,
  putBuilderSourceUploadChunk,
  completeBuilderSourceUpload,
  readBuilderSourceUploadStatus,
} from "@/app/actions/source-handoff";
import { uploadApplicationSource } from "@/lib/handoff/source-upload-client";
import { useBuilderControllerContext } from "./builder-form-context";
import styles from "./app-builder.module.css";

/** Source transfer is input preparation; later Build/publication retain their normal approvals. */
// eslint-disable-next-line eslint/func-style -- Match the existing named form island components.
export function BuilderSourceUpload() {
  const {
    form,
    setForm,
    setSourceUploadPending,
    appNameEditedByUser,
    generatedAppName,
    repositoryEditedByUser,
    repositoryNameFromAppName,
  } = useBuilderControllerContext();
  const [progress, setProgress] = useState("");
  const uploads = useRef(new Map<string, string>());
  const [outcome, dispatch, pending] = useActionState(
    async (_previous: { error?: string; complete?: boolean } | undefined, file: File) => {
      try {
        const uploaded = await uploadApplicationSource({
          file,
          onProgress: setProgress,
          ports: {
            begin: beginBuilderSourceUpload,
            complete: completeBuilderSourceUpload,
            put: putBuilderSourceUploadChunk,
            status: readBuilderSourceUploadStatus,
          },
          uploadIdForDigest: (digest) => {
            const cached = uploads.current.get(digest);
            if (cached !== undefined) {
              return cached;
            }
            const key = `builder-source-upload:${digest}`;
            let saved: string | null = null;
            try {
              saved = sessionStorage.getItem(key);
            } catch {
              /* Browser storage is optional; the live upload retains its ID. */
            }
            const parsed = sourceCandidateReferenceSchema.shape.uploadId.safeParse(saved);
            const id = parsed.success ? parsed.data : crypto.randomUUID();
            uploads.current.set(digest, id);
            try {
              sessionStorage.setItem(key, id);
            } catch {
              /* The in-memory receipt still supports retry in this mounted form. */
            }
            return id;
          },
        });
        appNameEditedByUser.current = true;
        generatedAppName.current = undefined;
        setForm((current) => ({
          ...current,
          appName: uploaded.displayName,
          repository: repositoryEditedByUser.current
            ? current.repository
            : repositoryNameFromAppName(uploaded.reference.appId),
          sourceCandidate: uploaded.reference,
        }));
        setProgress(
          `Source verified for ${uploaded.displayName}. ${uploaded.omissions} excluded files reported in the source artifact.`,
        );
        return { complete: true };
      } catch {
        return {
          error:
            "Source upload was not confirmed. Select the same artifact to reconcile or retry; no app was published.",
        };
      } finally {
        setSourceUploadPending(false);
      }
    },
    globalThis.undefined,
  );
  return (
    <section aria-label="Continue a local app">
      <label>
        <span className={styles.fieldLabel}>
          Continue a local app <small>Optional</small>
        </span>
        <input
          type="file"
          accept="application/json,.json"
          aria-label="App source artifact"
          disabled={pending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) {
              setSourceUploadPending(true);
              startTransition(() => {
                dispatch(file);
              });
            }
            event.target.value = "";
          }}
        />
      </label>
      <p className={styles.helpText}>
        Upload the source artifact exported by Builder. Your local conversation stays saved; this
        continues its app source with fresh approvals.
      </p>
      {form.sourceCandidate ? (
        <button
          type="button"
          onClick={() => {
            setForm((current) => ({ ...current, sourceCandidate: undefined }));
          }}
        >
          Use a new app brief instead
        </button>
      ) : null}
      {form.sourceCandidate ? (
        <p>
          Selected app: {form.sourceCandidate.appId}. Its identity is retained when you edit the
          display name.
        </p>
      ) : null}
      {progress ? <p role="status">{progress}</p> : null}
      {outcome?.error === undefined ? null : <p role="alert">{outcome.error}</p>}
    </section>
  );
}
