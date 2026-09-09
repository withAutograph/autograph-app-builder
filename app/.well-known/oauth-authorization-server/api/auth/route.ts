import { createPreviewOAuthWellKnownHandler } from "@/lib/auth/preview-oauth-deployment";

const requestHandler = createPreviewOAuthWellKnownHandler({
  environment: process.env,
});

export { requestHandler as GET };
