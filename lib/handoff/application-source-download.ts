import { createLocalApplicationSourceStore } from "./local-application-source-store";

export const createApplicationSourceDownloadHandler =
  (environment: Record<string, string | undefined>) =>
  async (request: Request, selection: { sessionId: string; digest: string }) => {
    try {
      const requestUrl = new URL(request.url);
      const configured = environment.APP_BUILDER_DEVELOPMENT_ORIGIN;
      if (
        configured === undefined ||
        configured === "" ||
        new URL(configured).origin !== requestUrl.origin ||
        !["127.0.0.1", "localhost"].includes(requestUrl.hostname)
      ) {
        return new Response("Not found", { status: 404 });
      }
      const saved = await createLocalApplicationSourceStore(environment).read(
        selection.sessionId,
        selection.digest,
      );
      return new Response(new Uint8Array(saved.bytes), {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${saved.manifest.appId}.application-source.json"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
        },
      });
    } catch {
      return new Response("Source download unavailable", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }
  };
