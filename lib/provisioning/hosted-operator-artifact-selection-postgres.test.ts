/* oxlint-disable promise/avoid-new, promise/prefer-await-to-callbacks -- A test-owned PostgreSQL cluster obtains its own available TCP port. */
/* oxlint-disable eslint/require-await -- The controlled owner assertion implements the asynchronous production read port. */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- The production database port carries the complete Drizzle schema type.
import * as schema from "../db/schema";
import { createPostgresOperatorArtifactSelections } from "./hosted-operator-artifact-selection";
import type { CompiledOperatorReleaseSelection } from "./hosted-operator-artifact-selection";

const tools = [
  "/Applications/Postgres.app/Contents/Versions/17/bin",
  "/opt/homebrew/opt/postgresql@17/bin",
  "/usr/lib/postgresql/17/bin",
].find((candidate) => {
  try {
    return /PostgreSQL\) 17\./u.test(
      execFileSync(path.join(candidate, "postgres"), ["--version"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    return false;
  }
});
const context = {
  authority: {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "fixture-workspace",
    ownerUserId: "fixture-owner",
  },
  target: { appId: "requests", sessionId: "fixture-session" },
};
const selected: CompiledOperatorReleaseSelection = {
  version: 1,
  appId: "requests",
  appSpecDigest: "a".repeat(64),
  artifactRef: `_protected-operator/artifacts/generated-release/requests/${"b".repeat(64)}`,
  releaseId: "requests-v1",
  manifestSha256: "c".repeat(64),
  schemaSha256: "d".repeat(64),
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const html = "<!doctype html><title>Owned fixture</title>";
let root: string | undefined;
let started = false;
let admin: ReturnType<typeof postgres> | undefined;
const client = () => {
  if (!admin) {
    throw new Error("Missing owned PostgreSQL fixture.");
  }
  return admin;
};

describe.skipIf(tools === undefined)(
  "exact retained selections with mixed prototype content in PostgreSQL",
  () => {
    beforeAll(async () => {
      /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
      if (!tools) {
        throw new Error("Owned PostgreSQL tools are unavailable.");
      }
      /* oxlint-enable typescript/strict-boolean-expressions */
      const port = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = z.object({ port: z.number().int().positive() }).parse(server.address());
          server.close((error) => {
            if (error === undefined) {
              resolve(address.port);
            } else {
              reject(error);
            }
          });
        });
      });
      root = await mkdtemp(path.join(tmpdir(), "builder-selection-pg-"));
      const data = path.join(root, "data");
      const password = randomBytes(24).toString("hex");
      const passwordFile = path.join(root, "password");
      await writeFile(passwordFile, password, { mode: 0o600 });
      execFileSync(
        path.join(tools, "initdb"),
        [
          "-D",
          data,
          "--username=fixture_admin",
          "--auth=scram-sha-256",
          `--pwfile=${passwordFile}`,
          "--no-locale",
        ],
        { stdio: "pipe" },
      );
      execFileSync(
        path.join(tools, "pg_ctl"),
        [
          "-D",
          data,
          "-l",
          path.join(root, "postgres.log"),
          "-o",
          `-h 127.0.0.1 -p ${port} -k ''`,
          "-w",
          "start",
        ],
        { stdio: "pipe" },
      );
      started = true;
      admin = postgres(`postgresql://fixture_admin:${password}@127.0.0.1:${port}/postgres`, {
        max: 1,
        prepare: false,
      });
      await admin`create table prototype_artifact_chunk (issuer text, audience text, workspace_id text, owner_user_id text, session_id text, path text, chunk_index integer, content text, chunk_digest text, transfer_digest text, created_at timestamptz)`;
      // Only this disposable cluster changes. Exercise PostgreSQL's legal AND-term
      // reordering instead of relying on the production planner's current cost ties.
      await admin`alter function pg_catalog.left(text, integer) cost 1000000`;
      const content = JSON.stringify(selected);
      const base = {
        ...context.authority,
        sessionId: context.target.sessionId,
        chunkIndex: 0,
        transferDigest: "fixture",
        createdAt: new Date(),
      };
      await drizzle(admin, { schema })
        .insert(schema.prototypeArtifactChunks)
        .values([
          {
            ...base,
            path: `_protected-operator/selections/generated-release/requests/${selected.appSpecDigest}`,
            content,
            chunkDigest: hash(content),
          },
          { ...base, path: "prototype/index.html", content: html, chunkDigest: hash(html) },
          {
            ...base,
            ownerUserId: "another-owner",
            path: `_protected-operator/selections/generated-release/requests/${selected.appSpecDigest}`,
            content,
            chunkDigest: hash(content),
          },
        ]);
    }, 30_000);
    afterAll(async () => {
      await admin?.end({ timeout: 2 });
      if (started && root !== undefined && tools !== undefined) {
        execFileSync(
          path.join(tools, "pg_ctl"),
          ["-D", path.join(root, "data"), "-m", "immediate", "-w", "stop"],
          { stdio: "pipe" },
        );
      }
      if (root !== undefined) {
        await rm(root, { recursive: true, force: true });
      }
    });

    it.each(["artifact", "release"] as const)(
      "reads the exact owned %s identity without parsing unrelated HTML",
      async (kind) => {
        let currentOwner = true;
        const selections = createPostgresOperatorArtifactSelections({
          database: drizzle(client(), { schema }),
          assertCurrentOwner: async () => {
            if (!currentOwner) {
              throw new Error("owner revoked");
            }
          },
        });
        const lookup =
          kind === "artifact"
            ? { artifactRef: selected.artifactRef }
            : { releaseId: selected.releaseId, schemaSha256: selected.schemaSha256 };
        expect(await selections.readExact?.(context, lookup)).toEqual(selected);
        expect(
          await selections.readExact?.(
            { ...context, authority: { ...context.authority, ownerUserId: "missing-owner" } },
            lookup,
          ),
        ).toBeUndefined();
        currentOwner = false;
        await expect(selections.readExact?.(context, lookup)).rejects.toThrow("owner revoked");
      },
    );
  },
);
