import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderDraftRecordSchema, saveActiveBuilderDraftInputSchema } from "./contracts";
import type {
  BuilderDraftRecord,
  BuilderDraftStatus,
  SaveActiveBuilderDraftInput,
} from "./contracts";

export type BuilderDraftAuthority = ReturnType<typeof hostedTenantAuthoritySchema.parse>;

export type BuilderDraftRow = {
  authority: BuilderDraftAuthority;
  draftId: string;
  status: BuilderDraftStatus;
  revision: number;
  record: BuilderDraftRecord;
  lastClientMutationId?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type BuilderDraftStore = {
  read: (input: {
    authority: BuilderDraftAuthority;
    draftId: string;
  }) => Promise<BuilderDraftRow | undefined>;
  readActive: (input: { authority: BuilderDraftAuthority }) => Promise<BuilderDraftRow | undefined>;
  saveActive: (input: {
    authority: BuilderDraftAuthority;
    draftId: string;
    expectedRevision: number;
    clientMutationId: string;
    record: BuilderDraftRecord;
    now: Date;
  }) => Promise<
    | {
        row: BuilderDraftRow;
        idempotent: true;
        concurrent: false;
      }
    | {
        row: BuilderDraftRow;
        idempotent: false;
        concurrent: boolean;
      }
  >;
  archive: (input: {
    authority: BuilderDraftAuthority;
    draftId: string;
    now: Date;
    expectedRevision?: number;
  }) => Promise<boolean>;
  deleteInactiveSince: (input: { now: Date; maxAgeMs?: number }) => Promise<number>;
};

export function createBuilderDraftService(input: { store: BuilderDraftStore; now?: () => Date }) {
  const now = input.now ?? (() => new Date());
  return {
    async readActive(authorityInput: BuilderDraftAuthority) {
      return input.store.readActive({
        authority: hostedTenantAuthoritySchema.parse(authorityInput),
      });
    },
    async read(authorityInput: BuilderDraftAuthority, draftId: string) {
      return input.store.read({
        authority: hostedTenantAuthoritySchema.parse(authorityInput),
        draftId: saveActiveBuilderDraftInputSchema.shape.draftId.parse(draftId),
      });
    },
    async saveActive(
      authorityInput: BuilderDraftAuthority,
      saveInput: SaveActiveBuilderDraftInput,
    ) {
      const authority = hostedTenantAuthoritySchema.parse(authorityInput);
      const parsed = saveActiveBuilderDraftInputSchema.parse(saveInput);
      return input.store.saveActive({
        authority,
        draftId: parsed.draftId,
        expectedRevision: parsed.expectedRevision,
        clientMutationId: parsed.clientMutationId,
        record: builderDraftRecordSchema.parse(parsed.record),
        now: now(),
      });
    },
    async archive(
      authorityInput: BuilderDraftAuthority,
      draftId: string,
      expectedRevision?: number,
    ) {
      return input.store.archive({
        authority: hostedTenantAuthoritySchema.parse(authorityInput),
        draftId: saveActiveBuilderDraftInputSchema.shape.draftId.parse(draftId),
        now: now(),
        ...(expectedRevision === undefined
          ? {}
          : {
              expectedRevision:
                saveActiveBuilderDraftInputSchema.shape.expectedRevision.parse(expectedRevision),
            }),
      });
    },
    /** Invoke only from scheduled maintenance; request paths must never purge drafts. */
    async deleteInactiveSince(maxAgeMs?: number) {
      return input.store.deleteInactiveSince({ now: now(), maxAgeMs });
    },
  };
}
