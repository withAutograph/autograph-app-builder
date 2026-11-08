import { z } from "zod";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import { appAccessSnapshotSchema } from "./contracts";
import type { AppAccessCommand, AppAccessSnapshot } from "./contracts";
import { AppAccessError } from "./errors";

export interface AppAccessOwner {
  appId: string;
  sessionId: string;
  ownerContext: OperatorOwnerContext;
}

const failureCode = async (response: Response) => {
  try {
    const parsed = z
      .object({ code: z.enum(["request_invalid", "request_id_conflict"]) })
      .safeParse(await response.json());
    return parsed.success ? parsed.data.code : undefined;
  } catch {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Malformed failure bodies do not establish a known rejection.
    return undefined;
  }
};

/** Carries user intent to the protected operator; no provider credential crosses this boundary. */
export const createAppAccessOperatorClient = (input: {
  endpoint: string;
  token: () => Promise<string>;
  fetch?: typeof fetch;
}) => {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.href !== `${endpoint.origin}/`) {
    throw new AppAccessError("app_access_unavailable");
  }
  const send = async (
    owner: AppAccessOwner,
    command?: AppAccessCommand,
    cursor?: string,
  ): Promise<AppAccessSnapshot> => {
    // Token acquisition is before dispatch: its failure is a known no-op.
    const token = await input.token();
    const requestBody = () => {
      const body: AppAccessOwner & {
        version: number;
        action: "access-status" | "access-command";
        command?: AppAccessCommand;
        cursor?: string;
      } = {
        version: 1,
        ...owner,
        action: command === undefined ? "access-status" : "access-command",
      };
      if (command !== undefined) {
        body.command = command;
      }
      if (cursor !== undefined) {
        body.cursor = cursor;
      }
      return body;
    };
    let response: Response;
    try {
      response = await (input.fetch ?? fetch)(new URL("/v1/repository-production", endpoint), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-vercel-trusted-oidc-idp-token": token,
        },
        body: JSON.stringify(requestBody()),
        cache: "no-store",
      });
    } catch {
      throw new AppAccessError(
        command === undefined ? "app_access_unavailable" : "app_access_unknown",
      );
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AppAccessError("app_access_denied");
      }
      if (response.status === 400 || response.status === 409) {
        const code = await failureCode(response);
        if (code !== undefined) {
          throw new AppAccessError(code);
        }
      }
      // A rejected response may follow a committed effect. Preserve the request identity.
      throw new AppAccessError(
        command === undefined ? "app_access_unavailable" : "app_access_unknown",
      );
    }
    try {
      const snapshot = appAccessSnapshotSchema.parse(await response.json());
      if (snapshot.appId !== owner.appId || snapshot.sessionId !== owner.sessionId) {
        throw new Error("App access response has a different owner scope.");
      }
      return snapshot;
    } catch {
      throw new AppAccessError(
        command === undefined ? "app_access_unavailable" : "app_access_unknown",
      );
    }
  };
  return {
    read: (owner: AppAccessOwner, cursor?: string) => send(owner, undefined, cursor),
    execute: (owner: AppAccessOwner, command: AppAccessCommand) => send(owner, command),
  };
};
