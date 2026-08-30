import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";

import { completeAuthorization } from "./completion";

const authorizationFields = [
  "response_type",
  "client_id",
  "state",
  "scope",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
] as const;

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  try {
    const emulation = readProviderEmulation(process.env);
    if (!emulation || emulation.mode !== "preview")
      throw new Error("Preview authentication emulation is unavailable.");
    const referer = new URL(request.headers.get("referer") ?? "");
    const { provider } = await context.params;
    if (
      referer.origin !== emulation.canonicalOrigin ||
      referer.pathname !== `/local-oauth/${provider}/authorize`
    )
      throw new Error("Invalid approval referer.");
    const searchParams = new URL(request.url).searchParams;
    return completeAuthorization(
      { params: Promise.resolve({ provider }) },
      Object.fromEntries(
        authorizationFields.map((name) => [
          name,
          searchParams.getAll(name).length === 1
            ? searchParams.get(name) ?? undefined
            : undefined,
        ]),
      ),
    );
  } catch {
    return new Response("Invalid local OAuth approval", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  try {
    const emulation = readProviderEmulation(process.env);
    if (!emulation || request.headers.get("origin") !== emulation.canonicalOrigin)
      throw new Error("Invalid approval origin.");
    const form = await request.formData();
    return completeAuthorization(
      context,
      Object.fromEntries(
        authorizationFields.map((name) => [
          name,
          typeof form.get(name) === "string"
            ? String(form.get(name))
            : undefined,
        ]),
      ),
    );
  } catch {
    return new Response("Invalid local OAuth approval", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
