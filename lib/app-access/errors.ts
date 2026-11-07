export type AppAccessErrorCode =
  | "authentication_required"
  | "app_access_denied"
  | "app_access_unavailable"
  | "app_access_unknown"
  | "request_invalid"
  | "request_id_conflict";

const messages: Record<AppAccessErrorCode, string> = {
  app_access_denied: "You do not have permission to manage access to this app.",
  app_access_unavailable:
    "Builder could not finish setting up access. Your app and progress are saved.",
  app_access_unknown:
    "Builder is checking the previous request. Retry that request before starting another.",
  authentication_required: "Sign in to Builder to continue.",
  request_id_conflict:
    "This request was already used for a different change. Refresh before continuing.",
  request_invalid: "Refresh this app’s access settings and try again.",
};

export class AppAccessError extends Error {
  readonly code: AppAccessErrorCode;
  constructor(code: AppAccessErrorCode) {
    super(messages[code]);
    this.code = code;
    this.name = "AppAccessError";
  }
}

export const appAccessErrorStatus = (code: AppAccessErrorCode): number => {
  if (code === "authentication_required") {
    return 401;
  }
  if (code === "app_access_denied") {
    return 403;
  }
  if (code === "request_invalid") {
    return 400;
  }
  if (code === "request_id_conflict" || code === "app_access_unknown") {
    return 409;
  }
  return 503;
};
