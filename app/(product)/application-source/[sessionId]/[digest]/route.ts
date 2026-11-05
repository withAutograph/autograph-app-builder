import { createApplicationSourceDownloadHandler } from "@/lib/handoff/application-source-download";
// oxlint-disable-next-line eslint/func-style, sonarjs/function-name -- Next requires named HTTP-method route exports.
export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string; digest: string }> },
) {
  return await createApplicationSourceDownloadHandler(process.env)(request, await context.params);
}
