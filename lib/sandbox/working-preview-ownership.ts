import type { Sandbox } from "@vercel/sandbox";

export interface PreviewAttempt {
  attemptId: string;
  providerSessionId: string;
  expiresAt: number;
  status: "starting" | "ready" | "cleanup-required";
  commandId?: string;
  supervisorPid?: number;
  supervisorPath?: string;
}

export const previewOwnershipRoot = "/workspace/.autograph-working-preview/ownership";

// SQLite serializes sandbox-local journal mutations and rolls back interrupted writes.
// The database is runtime state, outside the applied repository; no service is provisioned.
export const previewOwnershipSource = `
import * as ownershipFs from "node:fs";
import { DatabaseSync as OwnershipDatabase } from "node:sqlite";
const ownershipRoot = ${JSON.stringify(previewOwnershipRoot)};
const ownershipOpen = () => {
  ownershipFs.mkdirSync(ownershipRoot, {recursive:true});
  const database = new OwnershipDatabase(ownershipRoot + "/attempt.sqlite", {timeout:5000});
  database.exec("CREATE TABLE IF NOT EXISTS attempt (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)");
  return database;
};
const ownershipRead = () => {
  const database = ownershipOpen();
  try { const row = database.prepare("SELECT payload FROM attempt WHERE id=1").get(); return row ? JSON.parse(row.payload) : null; }
  finally { database.close(); }
};
const ownershipOperation = async (operation) => {
  const database = ownershipOpen();
  try {
    database.exec("BEGIN IMMEDIATE");
    const row = database.prepare("SELECT payload FROM attempt WHERE id=1").get();
    const current = row ? JSON.parse(row.payload) : null;
    let result = current;
    if (operation.kind === "claim") {
      if (current !== null) result = {claimed:false, attempt:current};
      else { database.prepare("INSERT INTO attempt (id,payload) VALUES (1,?)").run(JSON.stringify(operation.attempt)); result = {claimed:true, attempt:operation.attempt}; }
    } else if (operation.kind !== "read") {
      const owned = current?.attemptId === operation.attemptId && current?.providerSessionId === operation.providerSessionId;
      if (operation.kind === "release") {
        if (owned) database.exec("DELETE FROM attempt WHERE id=1");
        result = null;
      } else {
        if (!owned) throw new Error("Preview startup ownership changed.");
        if (operation.kind === "assert") {
          if (current.expiresAt <= Date.now() || current.status === "cleanup-required") throw new Error("Preview startup ownership expired or requires cleanup.");
        } else if (operation.kind === "update") {
          if ((operation.patch.status === "ready" || operation.patch.supervisorPid !== undefined) && (current.expiresAt <= Date.now() || current.status !== "starting")) throw new Error("Preview startup is no longer eligible for a ready result or supervisor.");
          result = {...current, ...operation.patch};
          database.prepare("UPDATE attempt SET payload=? WHERE id=1").run(JSON.stringify(result));
        } else throw new Error("Unknown preview ownership operation.");
      }
    }
    database.exec("COMMIT");
    return result;
  } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
  finally { database.close(); }
};
`;

type OwnershipOperation =
  | { kind: "read" }
  | { kind: "claim"; attempt: PreviewAttempt }
  | { kind: "assert" | "release"; attemptId: string; providerSessionId: string }
  | {
      kind: "update";
      attemptId: string;
      providerSessionId: string;
      patch: Partial<PreviewAttempt>;
    };

export const previewOwnershipOperation = async <T>(
  provider: Sandbox,
  operation: OwnershipOperation,
  signal?: AbortSignal,
): Promise<T> => {
  const command = await provider.runCommand({
    args: [
      "--input-type=module",
      "-e",
      `${previewOwnershipSource}\nconsole.log(JSON.stringify(await ownershipOperation(${JSON.stringify(operation)})));`,
    ],
    cmd: "node",
    signal,
  });
  if (command.exitCode !== 0) {
    throw new Error(
      "The preview ownership journal could not be updated; retry cleanup before starting another preview.",
    );
  }
  return JSON.parse(await command.stdout({ signal })) as T;
};
