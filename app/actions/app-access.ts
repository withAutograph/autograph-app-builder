"use server";

import { headers } from "next/headers";
import { createAppAccessAction } from "@/lib/app-access/action";
import type { AppAccessActionInput, AppAccessActionState } from "@/lib/app-access/action";
import { handleBuilderAppAccess } from "@/lib/app-access/deployment";
import { readPreviewOAuthRuntimeConfig } from "@/lib/auth/preview-oauth-runtime";

export const continueBuilderAppAccess = async (
  _previous: AppAccessActionState | undefined,
  input: AppAccessActionInput,
): Promise<AppAccessActionState> => {
  try {
    const config = readPreviewOAuthRuntimeConfig(process.env);
    return await createAppAccessAction({
      origin: new URL(config.issuer).origin,
      handle: handleBuilderAppAccess,
    })(input, new Headers(await headers()));
  } catch {
    return {
      status: "error",
      code: "app_access_unavailable",
      message: "Access setup is temporarily unavailable. Your app is saved.",
      uncertain: true,
    };
  }
};
