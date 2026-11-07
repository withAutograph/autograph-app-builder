import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  decryptVersionedVercelToken,
  encryptVercelToken,
  VercelTokenDecryptionKeyError,
} from "../integrations/vercel-installation";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import { centralHostCanonicalBytes } from "./central-integration-host-contract";
import { HostedOperatorError } from "./hosted-operator-contract";
import { assertAuthProposalMigrationUrl } from "./hosted-operator-auth-proposal";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const purpose = "native-target-auth-only-credentials-v1";
const password = z
  .string()
  .min(32)
  .max(512)
  .refine((value) => !/[\0\r\n]/u.test(value));
const credentialsSchema = z.strictObject({ migratorPassword: password, runtimePassword: password });

export const authOnlyCredentialContextSchema = z.strictObject({
  appId: id,
  authority: hostedTenantAuthoritySchema,
  operationRef: z.uuid(),
  profile: z.strictObject({ id, authorityDigest: digest }),
  resource: z
    .strictObject({
      resourceId: id,
      environment: z.literal("preview"),
      database: id,
      migratorRole: id,
      runtimeRole: id,
      neon: z.strictObject({
        projectId: id,
        branchId: id,
        endpointId: id,
        hostname: z
          .string()
          .regex(/^[a-z0-9.-]+\.neon\.tech$/u)
          .refine((value) => !value.includes("-pooler.")),
      }),
    })
    .refine((resource) => resource.migratorRole !== resource.runtimeRole),
  sessionId: id,
});
export type AuthOnlyCredentialContext = z.infer<typeof authOnlyCredentialContextSchema>;

export const authOnlyCredentialRecordSchema = z.strictObject({
  context: authOnlyCredentialContextSchema,
  kind: z.literal(purpose),
  privateState: z.strictObject({
    encryptedToken: id,
    tokenIv: id,
    tokenTag: id,
    keyVersion: id,
  }),
  version: z.literal(1),
});
export type AuthOnlyCredentialRecord = z.infer<typeof authOnlyCredentialRecordSchema>;

export const authOnlyCredentialRefSchema = z.strictObject({
  contextDigest: digest,
  kind: z.literal("auth-only-credentials"),
  recordDigest: digest,
  version: z.literal(1),
});
export type AuthOnlyCredentialRef = z.infer<typeof authOnlyCredentialRefSchema>;
export interface AuthOnlyCredentialStorageKey {
  context: AuthOnlyCredentialContext;
  contextDigest: string;
}
export interface AuthOnlyCredentialStore {
  read(key: AuthOnlyCredentialStorageKey): Promise<AuthOnlyCredentialRecord | undefined>;
  /** Atomic durable insert only. Existing ciphertext must never be replaced by a retry. */
  writeIfAbsent(
    key: AuthOnlyCredentialStorageKey,
    record: AuthOnlyCredentialRecord,
  ): Promise<"written" | "exists">;
}
export type AssertCurrentAuthOnlyCredentialAuthority = (
  context: AuthOnlyCredentialContext,
) => Promise<{ authorityDigest: string; resource: AuthOnlyCredentialContext["resource"] }>;
interface Access {
  context: AuthOnlyCredentialContext;
  /** Re-read the canonical owner, approved operation and profile; return its actual resource and recomputed authority digest. */
  assertCurrent: AssertCurrentAuthOnlyCredentialAuthority;
}

const mismatch = () => new HostedOperatorError("resource_mismatch");
const canonical = (value: unknown) => centralHostCanonicalBytes(z.json().parse(value));
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const authOnlyCredentialContextDigest = (context: AuthOnlyCredentialContext) =>
  hash(context);
const associatedData = (context: AuthOnlyCredentialContext) =>
  canonical({ context, purpose }).toString("utf-8");
const reference = (record: AuthOnlyCredentialRecord): AuthOnlyCredentialRef => ({
  contextDigest: authOnlyCredentialContextDigest(record.context),
  kind: "auth-only-credentials",
  recordDigest: hash(record),
  version: 1,
});
const parseContext = (value: AuthOnlyCredentialContext) => {
  const parsed = authOnlyCredentialContextSchema.safeParse(value);
  if (!parsed.success) {
    throw mismatch();
  }
  return parsed.data;
};
const parseCredentials = (value: z.input<typeof credentialsSchema>) => {
  const parsed = credentialsSchema.safeParse(value);
  if (!parsed.success) {
    throw mismatch();
  }
  return parsed.data;
};

/** Private custody only: neither creates database resources nor grants authority or generates replacement passwords. */
export const createHostedOperatorAuthOnlyCredentials = (deps: {
  keyring: VercelTokenKeyringConfig;
  store: AuthOnlyCredentialStore;
}) => {
  // Preserve the configured keyring while caller-owned buffers may change during storage awaits.
  const keyring = {
    ...deps.keyring,
    previousTokenKeys: deps.keyring.previousTokenKeys?.map((entry) => ({
      ...entry,
      key: Buffer.from(entry.key),
    })),
    tokenKey: Buffer.from(deps.keyring.tokenKey),
  };
  const assertCurrent = async (input: Access, context: AuthOnlyCredentialContext) => {
    let current: Awaited<ReturnType<AssertCurrentAuthOnlyCredentialAuthority>>;
    try {
      current = await input.assertCurrent(structuredClone(context));
    } catch (error) {
      if (error instanceof HostedOperatorError) {
        throw error;
      }
      throw new HostedOperatorError("authorization_required");
    }
    if (
      current?.authorityDigest !== context.profile.authorityDigest ||
      !isDeepStrictEqual(current.resource, context.resource)
    ) {
      throw new HostedOperatorError("authorization_required");
    }
  };
  const storageKey = (context: AuthOnlyCredentialContext): AuthOnlyCredentialStorageKey => ({
    context: structuredClone(context),
    contextDigest: authOnlyCredentialContextDigest(context),
  });
  const readRecord = async (context: AuthOnlyCredentialContext) => {
    let raw: AuthOnlyCredentialRecord | undefined;
    try {
      raw = await deps.store.read(storageKey(context));
    } catch {
      throw new HostedOperatorError("operator_unavailable");
    }
    if (raw === undefined) {
      return undefined;
    }
    const parsed = authOnlyCredentialRecordSchema.safeParse(raw);
    if (!parsed.success || !isDeepStrictEqual(parsed.data.context, context)) {
      throw mismatch();
    }
    return parsed.data;
  };
  const decrypt = (record: AuthOnlyCredentialRecord, context: AuthOnlyCredentialContext) => {
    try {
      return credentialsSchema.parse(
        JSON.parse(
          decryptVersionedVercelToken({
            ...record.privateState,
            associatedData: associatedData(context),
            config: keyring,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof VercelTokenDecryptionKeyError) {
        throw new HostedOperatorError("authorization_required");
      }
      throw mismatch();
    }
  };
  const matchesCredentials = (
    record: AuthOnlyCredentialRecord,
    context: AuthOnlyCredentialContext,
    credentials: z.infer<typeof credentialsSchema>,
  ) => {
    if (!isDeepStrictEqual(decrypt(record, context), credentials)) {
      throw mismatch();
    }
  };
  return {
    async findReference(input: Access): Promise<AuthOnlyCredentialRef | null> {
      const context = parseContext(input.context);
      await assertCurrent(input, context);
      const record = await readRecord(context);
      await assertCurrent(input, context);
      return record === undefined ? null : reference(record);
    },
    async read(
      input: Access & { reference: AuthOnlyCredentialRef; runtimeConnection?: "direct" | "pooled" },
    ): Promise<{ migrationUrl: string; runtimeUrl: string }> {
      const context = parseContext(input.context);
      const parsedRef = authOnlyCredentialRefSchema.safeParse(input.reference);
      if (
        !parsedRef.success ||
        parsedRef.data.contextDigest !== authOnlyCredentialContextDigest(context)
      )
        throw mismatch();
      const expected = parsedRef.data;
      const runtimeConnection = input.runtimeConnection ?? "direct";
      if (runtimeConnection !== "direct" && runtimeConnection !== "pooled") throw mismatch();
      await assertCurrent(input, context);
      const record = await readRecord(context);
      await assertCurrent(input, context);
      if (record === undefined || !isDeepStrictEqual(reference(record), expected)) throw mismatch();
      const credentials = decrypt(record, context);
      const { resource } = context;
      const directUrl = (role: string, secret: string) => {
        const url = new URL(`postgresql://${resource.neon.hostname}:5432/`);
        url.username = encodeURIComponent(role);
        url.password = encodeURIComponent(secret);
        url.pathname = `/${encodeURIComponent(resource.database)}`;
        url.searchParams.set("sslmode", "verify-full");
        return url;
      };
      const migration = directUrl(resource.migratorRole, credentials.migratorPassword);
      const runtime = directUrl(resource.runtimeRole, credentials.runtimePassword);
      const validationResource = {
        version: 1 as const,
        environment: "preview" as const,
        hostname: resource.neon.hostname,
        port: 5432 as const,
        database: resource.database,
        schema: "public" as const,
        migratorRole: resource.migratorRole,
        runtimeRole: resource.runtimeRole,
        neon: { projectId: resource.neon.projectId, branchId: resource.neon.branchId },
      };
      assertAuthProposalMigrationUrl(migration.toString(), validationResource);
      assertAuthProposalMigrationUrl(runtime.toString(), {
        ...validationResource,
        migratorRole: resource.runtimeRole,
      });
      if (runtimeConnection === "pooled")
        runtime.hostname = resource.neon.hostname.replace(".", "-pooler.");
      await assertCurrent(input, context);
      return { migrationUrl: migration.toString(), runtimeUrl: runtime.toString() };
    },
    async readSecrets(
      input: Access & { reference: AuthOnlyCredentialRef },
    ): Promise<{ migratorPassword: string; runtimePassword: string }> {
      const context = parseContext(input.context);
      const parsedRef = authOnlyCredentialRefSchema.safeParse(input.reference);
      if (
        !parsedRef.success ||
        parsedRef.data.contextDigest !== authOnlyCredentialContextDigest(context)
      )
        throw mismatch();
      await assertCurrent(input, context);
      const record = await readRecord(context);
      await assertCurrent(input, context);
      if (record === undefined || !isDeepStrictEqual(reference(record), parsedRef.data))
        throw mismatch();
      const secret = decrypt(record, context);
      await assertCurrent(input, context);
      return structuredClone(secret);
    },
    async seal(
      input: Access & { credentials: z.input<typeof credentialsSchema> },
    ): Promise<AuthOnlyCredentialRef> {
      const context = parseContext(input.context);
      const credentials = parseCredentials(input.credentials);
      await assertCurrent(input, context);
      const existing = await readRecord(context);
      await assertCurrent(input, context);
      if (existing !== undefined) {
        matchesCredentials(existing, context, credentials);
        return reference(existing);
      }
      let record: AuthOnlyCredentialRecord;
      try {
        record = {
          version: 1,
          kind: purpose,
          context,
          privateState: {
            ...encryptVercelToken({
              token: JSON.stringify(credentials),
              key: keyring.tokenKey,
              associatedData: associatedData(context),
            }),
            keyVersion: keyring.tokenKeyVersion,
          },
        };
      } catch {
        throw new HostedOperatorError("operator_unavailable");
      }
      let outcome: "written" | "exists";
      try {
        outcome = await deps.store.writeIfAbsent(storageKey(context), structuredClone(record));
      } catch {
        // A lost response may have committed. Preserve the deterministic key for read-first recovery.
        throw new HostedOperatorError("operator_unavailable");
      }
      await assertCurrent(input, context);
      const observed = await readRecord(context);
      await assertCurrent(input, context);
      if (
        observed === undefined ||
        (outcome !== "written" && outcome !== "exists") ||
        (outcome === "written" && !isDeepStrictEqual(observed, record))
      ) {
        throw new HostedOperatorError("operation_in_progress");
      }
      matchesCredentials(observed, context, credentials);
      return reference(observed);
    },
  };
};
