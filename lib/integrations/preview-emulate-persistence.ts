import type { PersistenceAdapter } from "@emulators/core";
import postgres from "postgres";

const MAX_STATE_BYTES = 8 * 1024 * 1024;

export type PreviewEmulateStateStore = {
  read(namespace: string): Promise<string | undefined>;
  write(namespace: string, state: string, now: Date): Promise<void>;
  reset(namespace: string): Promise<number>;
};

function validateState(state: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    throw new Error("Preview emulator state is invalid.");
  }
  if (
    Buffer.byteLength(state, "utf8") > MAX_STATE_BYTES ||
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  )
    throw new Error("Preview emulator state is invalid.");
  return state;
}

export function createPreviewEmulatePersistence(input: {
  namespace: string;
  store: PreviewEmulateStateStore;
  now?: () => Date;
}): PersistenceAdapter {
  return {
    async load() {
      const state = await input.store.read(input.namespace);
      return state === undefined ? null : validateState(state);
    },
    async save(state) {
      await input.store.write(
        input.namespace,
        validateState(state),
        input.now?.() ?? new Date(),
      );
    },
  };
}

export function createPostgresPreviewEmulateStateStore(
  databaseUrl: string,
): PreviewEmulateStateStore {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  return {
    async read(namespace) {
      const rows = await sql<Array<{ state: string }>>`
        SELECT "state"
        FROM "emulate_preview_state"
        WHERE "namespace" = ${namespace}
        LIMIT 1
      `;
      return rows[0]?.state;
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
    async reset(namespace) {
      const rows = await sql<Array<{ namespace: string }>>`
        DELETE FROM "emulate_preview_state"
        WHERE "namespace" = ${namespace}
        RETURNING "namespace"
      `;
      return rows.length;
    },
  };
}

export async function resetPostgresPreviewEmulateState(
  databaseUrl: string,
  namespace: string,
) {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const rows = await sql<Array<{ namespace: string }>>`
      DELETE FROM "emulate_preview_state"
      WHERE "namespace" = ${namespace}
      RETURNING "namespace"
    `;
    return rows.length;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
