import { createEmulateHandler } from "@emulators/adapter-next";
import * as github from "@emulators/github";
import * as vercel from "@emulators/vercel";

import { providerEmulationSeed } from "./provider-emulation-seed";
import {
  readPreviewProviderEmulation,
  type PreviewProviderEmulation,
} from "./local-provider-emulation";
import {
  createPostgresPreviewEmulateStateStore,
  createPreviewEmulatePersistence,
} from "./preview-emulate-persistence";

type Handler = ReturnType<typeof createEmulateHandler>;

let active: { namespace: string; handler: Handler } | undefined;

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required for Preview emulation.`);
  return value;
}

export function createPreviewEmulateHandler(input: {
  emulation: PreviewProviderEmulation;
  databaseUrl: string;
  githubAppPrivateKey?: string;
}) {
  const seed = providerEmulationSeed({
    origin: input.emulation.canonicalOrigin,
    githubAppPrivateKey: input.githubAppPrivateKey,
    githubClientId: input.emulation.githubClientId,
    githubClientSecret: input.emulation.githubClientSecret,
    vercelClientId: input.emulation.vercelClientId,
    vercelClientSecret: input.emulation.vercelClientSecret,
    // Dynamic Preview callback origins are intentionally validated by the
    // app's canonical-origin gate rather than a seeded GitHub OAuth app.
    strictGitHubOAuth: false,
  });
  const persistence = createPreviewEmulatePersistence({
    namespace: input.emulation.namespace,
    store: createPostgresPreviewEmulateStateStore(input.databaseUrl),
  });
  let pendingPersistence = Promise.resolve();
  const handler = createEmulateHandler({
    services: {
      github: {
        emulator: github,
        seed: seed.github as unknown as Record<string, unknown>,
      },
      vercel: {
        emulator: vercel,
        seed: seed.vercel as unknown as Record<string, unknown>,
      },
    },
    persistence: {
      load: persistence.load,
      save(state) {
        pendingPersistence = persistence.save(state);
        return pendingPersistence;
      },
    },
  });
  const durableHandler = {} as Handler;
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    durableHandler[method] = async (request, context) => {
      const response = await handler[method](request, context);
      // adapter-next queues persistence after producing the response. Await its
      // save before returning so a serverless invocation cannot freeze with an
      // OAuth code only resident in memory.
      await Promise.resolve();
      await pendingPersistence;
      return response;
    };
  }
  return durableHandler;
}

function handler(environment: NodeJS.ProcessEnv) {
  const emulation = readPreviewProviderEmulation(environment);
  if (!emulation) return undefined;
  if (active?.namespace === emulation.namespace) return active.handler;
  const created = createPreviewEmulateHandler({
    emulation,
    databaseUrl: required(environment.DATABASE_URL, "DATABASE_URL"),
    githubAppPrivateKey: environment.EMULATE_PREVIEW_GITHUB_APP_PRIVATE_KEY,
  });
  active = { namespace: emulation.namespace, handler: created };
  return created;
}

export async function invokePreviewEmulateRequest(request: Request) {
  const selected = handler(process.env);
  if (!selected) return new Response("Not found", { status: 404 });
  const emulation = readPreviewProviderEmulation(process.env);
  const url = new URL(request.url);
  const prefix = "/api/emulate/";
  if (
    !emulation ||
    url.origin !== emulation.canonicalOrigin ||
    !url.pathname.startsWith(prefix)
  )
    return new Response("Not found", { status: 404 });
  const path = url.pathname.slice(prefix.length).split("/").filter(Boolean);
  const method = request.method as keyof Handler;
  const selectedMethod = selected[method];
  if (typeof selectedMethod !== "function")
    return new Response("Method not allowed", { status: 405 });
  return selectedMethod(request, { params: Promise.resolve({ path }) });
}

export function previewEmulateRoute(method: keyof Handler) {
  return async (
    request: Request,
    context: { params: Promise<{ path: string[] }> },
  ) => {
    try {
      const selected = handler(process.env);
      if (!selected) return new Response("Not found", { status: 404 });
      return await selected[method](request, context);
    } catch {
      return new Response("Preview emulator unavailable", { status: 503 });
    }
  };
}
