"use server";

import { randomUUID } from "node:crypto";

import { headers } from "next/headers";

import {
  builderDraftRecordSchema,
  saveActiveBuilderDraftInputSchema,
} from "@/lib/builder-drafts/contracts";
import type {
  BuilderDraftRecord,
  SaveActiveBuilderDraftInput,
} from "@/lib/builder-drafts/contracts";
import {
  getAuthenticatedBuilderDraftContext,
  readAuthenticatedActiveBuilderDraft,
  readAuthenticatedBuilderDraft,
} from "@/lib/builder-drafts/deployment";

async function context() {
  const value = await getAuthenticatedBuilderDraftContext({
    environment: process.env,
    headers: await headers(),
  });
  if (!value) {
    throw new Error("builder-draft-unauthorized");
  }
  return value;
}

/** The revisioned mutation used by the autosave island and provider redirects. */
export async function saveActiveBuilderDraft(
  input: SaveActiveBuilderDraftInput
) {
  const value = await context();
  const saved = await value.drafts.saveActive(
    value.authority,
    saveActiveBuilderDraftInputSchema.parse(input)
  );
  return {
    concurrent: saved.concurrent,
    draftId: saved.row.draftId,
    idempotent: saved.idempotent,
    revision: saved.row.revision,
    updatedAt: saved.row.updatedAt.toISOString(),
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
    draftId,
    environment: process.env,
    headers: await headers(),
  });
}

/**
 * Temporary compatibility shim for the pre-autosave client. New code must use
 * `saveActiveBuilderDraft` so every mutation carries its revision and UUID.
 */
export async function saveBuilderDraft(
  draftId: string,
  recordInput: BuilderDraftRecord
) {
  const value = await context();
  const record = builderDraftRecordSchema.parse(recordInput);
  const current = await value.drafts.read(value.authority, draftId);
  return saveActiveBuilderDraft({
    clientMutationId: randomUUID(),
    draftId,
    expectedRevision: current?.revision ?? 0,
    record,
    version: 1,
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
