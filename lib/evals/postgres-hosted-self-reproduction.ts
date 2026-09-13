import { createHash } from "node:crypto";
import type { JSONValue, Sql } from "postgres";
import type {
  HostedEvalArtifacts,
  HostedEvalRecord,
  HostedEvalStore,
} from "./hosted-self-reproduction-controller";

/** Private controller storage. Authorization remains at the controller boundary. */
export const createPostgresHostedEvalStorage = (database: Sql) => {
  const recordValue = (record: HostedEvalRecord) =>
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Normalize to JSON values, including omission of undefined fields, before driver serialization.
    database.json(JSON.parse(JSON.stringify(record)) as JSONValue);
  const read: HostedEvalStore["read"] = async (id) => {
    const rows = await database<{ record: HostedEvalRecord }[]>`
      SELECT record FROM hosted_self_reproduction_run WHERE id = ${id}
    `;
    return rows[0]?.record;
  };
  const store: HostedEvalStore = {
    async compareAndSet(expected, record) {
      if (record.revision !== expected + 1)
        throw new Error("Eval revision must advance exactly once.");
      const rows = await database<{ id: string }[]>`
        UPDATE hosted_self_reproduction_run
        SET revision = ${record.revision}, record = ${recordValue(record)}
        WHERE id = ${record.id} AND revision = ${expected}
        RETURNING id
      `;
      return rows.length === 1;
    },
    read,
    async reserve(record) {
      const rows = await database<{ record: HostedEvalRecord }[]>`
        INSERT INTO hosted_self_reproduction_run (id, revision, record)
        VALUES (${record.id}, ${record.revision}, ${recordValue(record)})
        ON CONFLICT (id) DO NOTHING RETURNING record
      `;
      if (rows[0]) return { created: true, record: rows[0].record };
      const existing = await read(record.id);
      if (!existing) throw new Error("The reserved eval run could not be read.");
      return { created: false, record: existing };
    },
  };
  const artifacts: HostedEvalArtifacts = {
    async put(runId, artifact, content) {
      const key = createHash("sha256")
        .update(JSON.stringify([runId, artifact.id]))
        .digest("hex");
      await database`
        INSERT INTO hosted_self_reproduction_artifact
          (storage_key, run_id, artifact_id, content_type, content)
        VALUES (${key}, ${runId}, ${artifact.id}, ${artifact.contentType}, ${Buffer.from(content)})
        ON CONFLICT (run_id, artifact_id) DO NOTHING
      `;
      return key;
    },
    async read(key) {
      const rows = await database<{ content: Buffer }[]>`
        SELECT content FROM hosted_self_reproduction_artifact WHERE storage_key = ${key}
      `;
      if (!rows[0]) throw new Error("Retained eval artifact is unavailable.");
      return new Uint8Array(rows[0].content);
    },
  };
  return { artifacts, store };
};
