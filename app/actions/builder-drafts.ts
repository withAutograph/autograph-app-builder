"use server";

import { randomUUID } from "node:crypto";

import { headers } from "next/headers";

import {
  getAuthenticatedBuilderDraftContext,
  readAuthenticatedActiveBuilderDraft,
  readAuthenticatedBuilderDraft,
} from "@/lib/builder-drafts/deployment";
import {
  builderDraftRecordSchema,
  saveActiveBuilderDraftInputSchema,
  type BuilderDraftRecord,
  type SaveActiveBuilderDraftInput,
} from "@/lib/builder-drafts/contracts";

async function context() {
  const value = await getAuthenticatedBuilderDraftContext({
    environment: process.env,
    headers: await headers(),
  });
  if (!value) throw new Error("builder-draft-unauthorized");
  return value;
}

/** The revisioned mutation used by the autosave island and provider redirects. */
export async function saveActiveBuilderDraft(
  input: SaveActiveBuilderDraftInput,
) {
  const value = await context();
  const saved = await value.drafts.saveActive(
    value.authority,
    saveActiveBuilderDraftInputSchema.parse(input),
  );
  return {
    draftId: saved.row.draftId,
    revision: saved.row.revision,
    updatedAt: saved.row.updatedAt.toISOString(),
    idempotent: saved.idempotent,
    concurrent: saved.concurrent,
  };
}

export async function loadActiveBuilderDraft() {
  return readAuthenticatedActiveBuilderDraft({
    environment: process.env,
    headers: await headers(),
  });
}

export async function loadBuilderDraft(draftId: string) {
  return readAuthenticatedBuilderDraft({
    environment: process.env,
    headers: await headers(),
    draftId,
  });
}

/**
 * Temporary compatibility shim for the pre-autosave client. New code must use
 * `saveActiveBuilderDraft` so every mutation carries its revision and UUID.
 */
export async function saveBuilderDraft(
  draftId: string,
  recordInput: BuilderDraftRecord,
) {
  const value = await context();
  const record = builderDraftRecordSchema.parse(recordInput);
  const current = await value.drafts.read(value.authority, draftId);
  return saveActiveBuilderDraft({
    version: 1,
    draftId,
    expectedRevision: current?.revision ?? 0,
    clientMutationId: randomUUID(),
    record,
  });
}

export async function clearBuilderDraft(draftId: string) {
  const value = await context();
  return value.drafts.archive(value.authority, draftId);
}

/** One active draft means this legacy list contains zero or one item. */
export async function listLatestBuilderDrafts() {
  const draft = await loadActiveBuilderDraft();
  return draft ? [draft] : [];
}
