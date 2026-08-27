import { createPreviewOAuthWellKnownHandler } from "@/lib/auth/preview-oauth-deployment";

export const runtime = "nodejs";

const requestHandler = createPreviewOAuthWellKnownHandler({
  environment: process.env,
});

export { requestHandler as GET };
