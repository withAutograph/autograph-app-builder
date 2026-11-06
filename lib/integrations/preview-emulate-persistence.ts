import type { PersistenceAdapter } from "@emulators/core";
import postgres from "postgres";

const MAX_STATE_BYTES = 8 * 1024 * 1024;

interface PreviewEmulateSnapshot {
  store?: {
    data?: {
      "vercel:vercel.oauth.pendingCodes"?: {
        entries?: unknown[];
      };
    };
  };
}

interface PreviewEmulateJsonObject {
  store?: unknown;
  data?: unknown;
  "vercel:vercel.oauth.pendingCodes"?: unknown;
  entries?: unknown;
}

function isPreviewEmulateJsonObject(value: unknown): value is PreviewEmulateJsonObject {
  return (
    value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  );
}

function parseSnapshot(state: string): PreviewEmulateSnapshot | undefined {
  try {
    const root: unknown = JSON.parse(state);
    if (!isPreviewEmulateJsonObject(root)) return undefined;
    const { store } = root;
    if (!isPreviewEmulateJsonObject(store)) return undefined;
    const { data } = store;
    if (!isPreviewEmulateJsonObject(data)) return undefined;
    const { "vercel:vercel.oauth.pendingCodes": pendingCodes } = data;
    if (!isPreviewEmulateJsonObject(pendingCodes)) return undefined;
    const { entries } = pendingCodes;
    return {
      store: {
        data: {
          "vercel:vercel.oauth.pendingCodes": {
            entries: Array.isArray(entries) ? entries : undefined,
          },
        },
      },
    };
  } catch {
    return undefined;
  }
}

export interface PreviewEmulateStateStore {
  read: (namespace: string) => Promise<string | undefined>;
  write: (namespace: string, state: string, now: Date) => Promise<void>;
  reset: (namespace: string) => Promise<number>;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function validateState(state: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    throw new Error("Preview emulator state is invalid.");
  }
  if (Buffer.byteLength(state, "utf-8") > MAX_STATE_BYTES || !isPreviewEmulateJsonObject(parsed)) {
    throw new Error("Preview emulator state is invalid.");
  }
  return state;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function pendingVercelCodeCount(state: string | undefined) {
  if (state === undefined || state === "") {
    return 0;
  }
  const snapshot = parseSnapshot(state);
  return snapshot?.store?.data?.["vercel:vercel.oauth.pendingCodes"]?.entries?.length ?? 0;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPreviewEmulatePersistence(input: {
  namespace: string;
  store: PreviewEmulateStateStore;
  now?: () => Date;
}): PersistenceAdapter {
  return {
    async load() {
      const state = await input.store.read(input.namespace);
      console.info(
        JSON.stringify({
          level: "info",
          message: "preview_emulator_state_loaded",
          pendingVercelCodes: pendingVercelCodeCount(state),
        }),
      );
      return state === undefined ? null : validateState(state);
    },
    async save(state) {
      await input.store.write(input.namespace, validateState(state), input.now?.() ?? new Date());
      console.info(
        JSON.stringify({
          level: "info",
          message: "preview_emulator_state_saved",
          pendingVercelCodes: pendingVercelCodeCount(state),
        }),
      );
    },
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresPreviewEmulateStateStore(
  databaseUrl: string,
): PreviewEmulateStateStore {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  return {
    async read(namespace) {
      const rows = await sql<{ state: string }[]>`
        SELECT "state"
        FROM "emulate_preview_state"
        WHERE "namespace" = ${namespace}
        LIMIT 1
      `;
      return rows[0]?.state;
    },
    async reset(namespace) {
      const rows = await sql<{ namespace: string }[]>`
        DELETE FROM "emulate_preview_state"
        WHERE "namespace" = ${namespace}
        RETURNING "namespace"
      `;
      return rows.length;
    },
    async write(namespace, state, now) {
      await sql`
        INSERT INTO "emulate_preview_state" (
          "namespace", "state", "created_at", "updated_at"
        ) VALUES (${namespace}, ${state}, ${now}, ${now})
        ON CONFLICT ("namespace") DO UPDATE SET
          "state" = EXCLUDED."state",
          "updated_at" = EXCLUDED."updated_at"
      `;
    },
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function resetPostgresPreviewEmulateState(databaseUrl: string, namespace: string) {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const rows = await sql<{ namespace: string }[]>`
      DELETE FROM "emulate_preview_state"
      WHERE "namespace" = ${namespace}
      RETURNING "namespace"
    `;
    return rows.length;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
