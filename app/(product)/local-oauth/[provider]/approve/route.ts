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

// oxlint-disable-next-line sonarjs/function-name, eslint/func-style -- Next.js discovers this named HTTP method export. Preserve function declaration hoisting and initialization timing.
export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  let completion: ReturnType<typeof completeAuthorization>;
  try {
    const emulation = readProviderEmulation(process.env);
    if (!emulation || emulation.mode !== "preview") {
      throw new Error("Preview authentication emulation is unavailable.");
    }
    const referer = new URL(request.headers.get("referer") ?? "");
    const { provider } = await context.params;
    if (
      referer.origin !== emulation.canonicalOrigin ||
      referer.pathname !== `/local-oauth/${provider}/authorize`
    ) {
      throw new Error("Invalid approval referer.");
    }
    const { searchParams } = new URL(request.url);
    completion = completeAuthorization(
      { params: Promise.resolve({ provider }) },
      Object.fromEntries(
        authorizationFields.map((name) => [
          name,
          searchParams.getAll(name).length === 1
            ? (searchParams.get(name) ?? undefined)
            : undefined,
        ]),
      ),
    );
  } catch {
    return new Response("Invalid local OAuth approval", {
      headers: { "Cache-Control": "no-store" },
      status: 400,
    });
  }
  return await completion;
}

// oxlint-disable-next-line sonarjs/function-name, eslint/func-style -- Next.js discovers this named HTTP method export. Preserve function declaration hoisting and initialization timing.
export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  let completion: ReturnType<typeof completeAuthorization>;
  try {
    const emulation = readProviderEmulation(process.env);
    if (!emulation || request.headers.get("origin") !== emulation.canonicalOrigin) {
      throw new Error("Invalid approval origin.");
    }
    const form = await request.formData();
    completion = completeAuthorization(
      context,
      Object.fromEntries(
        authorizationFields.map((name) => {
          const value = form.get(name);
          return [name, typeof value === "string" ? value : undefined];
        }),
      ),
    );
  } catch {
    return new Response("Invalid local OAuth approval", {
      headers: { "Cache-Control": "no-store" },
      status: 400,
    });
  }
  return await completion;
}
