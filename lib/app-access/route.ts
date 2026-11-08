import { isDeepStrictEqual } from "node:util";
import { appAccessCommandSchema, appAccessSnapshotSchema } from "./contracts";
import type { AppAccessCommand, AppAccessSnapshot } from "./contracts";
import type { AppAccessOwner } from "./operator-client";
import { AppAccessError, appAccessErrorStatus } from "./errors";
import { reportRepositoryProductionFailure } from "../provisioning/repository-production-diagnostic";

/** Public navigation remains separate from the canonical protected operator scope. */
export interface AppAccessRouteOwner {
  publicSessionId: string;
  operatorOwner: AppAccessOwner;
}

const noStore = { "cache-control": "no-store" };

// A bound on one untrusted HTTP command, not on app members or total operations.
const readCommand = async (request: Request): Promise<AppAccessCommand> => {
  const reader = request.body?.getReader();
  if (reader === undefined) {
    throw new AppAccessError("request_invalid");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- A single bounded request stream must be read in order.
      const next = await reader.read();
      if (next.done) {
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > 65_536) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Stop reading this request immediately when its security bound is exceeded.
        await reader.cancel();
        throw new AppAccessError("request_invalid");
      }
      chunks.push(next.value);
    }
    const data = Buffer.concat(chunks);
    return appAccessCommandSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)),
    );
  } catch {
    throw new AppAccessError("request_invalid");
  } finally {
    reader.releaseLock();
  }
};

export const createAppAccessRouteHandler =
  (input: {
    origin: string;
    resolveOwner: (request: Request, sessionId: string) => Promise<AppAccessRouteOwner>;
    read: (owner: AppAccessOwner, cursor?: string) => Promise<AppAccessSnapshot>;
    execute: (owner: AppAccessOwner, command: AppAccessCommand) => Promise<AppAccessSnapshot>;
  }) =>
  async (request: Request, sessionId: string): Promise<Response> => {
    let phase: Parameters<typeof reportRepositoryProductionFailure>[0] = "access_request";
    try {
      const url = new URL(request.url);
      if (url.origin !== input.origin || !sessionId) {
        throw new AppAccessError("request_invalid");
      }
      if (request.method !== "GET" && request.method !== "POST") {
        return Response.json(
          { message: "Method not allowed." },
          { status: 405, headers: { ...noStore, allow: "GET, POST" } },
        );
      }
      let command: AppAccessCommand | undefined;
      if (request.method === "POST") {
        if (
          request.headers.get("origin") !== input.origin ||
          request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
        ) {
          throw new AppAccessError("request_invalid");
        }
        command = await readCommand(request);
      }
      phase = "access_owner_resolve";
      const resolved = await input.resolveOwner(request, sessionId);
      if (resolved.publicSessionId !== sessionId) {
        throw new AppAccessError("app_access_denied");
      }
      const owner = resolved.operatorOwner;
      const cursor = url.searchParams.get("cursor") ?? undefined;
      phase = "access_operator_read";
      const raw =
        command === undefined
          ? await input.read(owner, cursor)
          : await input.execute(owner, command);
      phase = "access_projection";
      const snapshot = appAccessSnapshotSchema.parse(raw);
      if (snapshot.sessionId !== owner.sessionId || snapshot.appId !== owner.appId) {
        throw new AppAccessError(
          command === undefined ? "app_access_unavailable" : "app_access_unknown",
        );
      }
      phase = "access_owner_recheck";
      const current = await input.resolveOwner(request, sessionId);
      if (!isDeepStrictEqual(current, resolved)) {
        throw new AppAccessError("app_access_denied");
      }
      return Response.json({ ...snapshot, sessionId }, { headers: noStore });
    } catch (error) {
      if (request.method === "GET") {
        reportRepositoryProductionFailure(phase, "binding_unavailable", error);
      }
      const safe =
        error instanceof AppAccessError ? error : new AppAccessError("app_access_unavailable");
      return Response.json(
        { code: safe.code, message: safe.message },
        { status: appAccessErrorStatus(safe.code), headers: noStore },
      );
    }
  };
