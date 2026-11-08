import { z } from "zod";
import {
  appAccessApiPath,
  appAccessCommandSchema,
  appAccessFailureSchema,
  appAccessSnapshotSchema,
} from "./contracts";
import type { AppAccessSnapshot } from "./contracts";

export const appAccessActionInputSchema = z.strictObject({
  sessionId: z.string().min(1),
  command: appAccessCommandSchema,
});
export type AppAccessActionInput = z.infer<typeof appAccessActionInputSchema>;
export type AppAccessActionState =
  | { status: "ready"; snapshot: AppAccessSnapshot }
  | { status: "error"; message: string; code?: string; uncertain: boolean };

/** Server Action transport over the existing authenticated, owner-resolving service. */
export const createAppAccessAction =
  (deps: { origin: string; handle: (request: Request, sessionId: string) => Promise<Response> }) =>
  async (input: AppAccessActionInput, incoming: Headers): Promise<AppAccessActionState> => {
    const parsed = appAccessActionInputSchema.safeParse(input);
    if (!parsed.success || incoming.get("origin") !== deps.origin) {
      return {
        status: "error",
        code: "request_invalid",
        message: "Builder couldn’t accept this update. Your app is saved.",
        uncertain: false,
      };
    }
    const { sessionId, command } = parsed.data;
    try {
      const requestHeaders = new Headers(incoming);
      requestHeaders.set("content-type", "application/json");
      const response = await deps.handle(
        new Request(new URL(appAccessApiPath(sessionId), deps.origin), {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(command),
        }),
        sessionId,
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        const failure = appAccessFailureSchema.safeParse(body);
        const errorState: Pick<
          Extract<AppAccessActionState, { status: "error" }>,
          "status" | "message" | "code"
        > = {
          status: "error",
          message: failure.success
            ? failure.data.message
            : "Builder couldn’t confirm this update. Retry to check the same request.",
        };
        if (failure.success && failure.data.code !== undefined) {
          errorState.code = failure.data.code;
        }
        return { ...errorState, uncertain: response.status >= 500 || response.status === 409 };
      }
      const snapshot = appAccessSnapshotSchema.parse(body);
      if (snapshot.sessionId !== sessionId) {
        throw new Error("app_access_unknown");
      }
      return { status: "ready", snapshot };
    } catch {
      return {
        status: "error",
        code: "app_access_unknown",
        message: "Builder couldn’t confirm this update. Retry to check the same request.",
        uncertain: true,
      };
    }
  };
