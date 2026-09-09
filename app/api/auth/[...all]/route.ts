import { createPreviewOAuthRequestHandler } from "@/lib/auth/preview-oauth-deployment";

const requestHandler = createPreviewOAuthRequestHandler({
  environment: process.env,
});

export { requestHandler as GET, requestHandler as POST };
