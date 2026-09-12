import { createEmulateHandler } from "@emulators/adapter-next";
import * as github from "@emulators/github";
import * as vercel from "@emulators/vercel";

import { providerEmulationSeed } from "./provider-emulation-seed";
import { readPreviewProviderEmulation } from "./local-provider-emulation";
import type { PreviewProviderEmulation } from "./local-provider-emulation";
import {
  createPostgresPreviewEmulateStateStore,
  createPreviewEmulatePersistence,
} from "./preview-emulate-persistence";

type Handler = ReturnType<typeof createEmulateHandler>;

let active: { namespace: string; handler: Handler } | undefined;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required for Preview emulation.`);
  return value;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
  let persistenceRevision = 0;
  const emulateHandler = createEmulateHandler({
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
        persistenceRevision += 1;
        pendingPersistence = persistence.save(state);
        return pendingPersistence;
      },
    },
  });
  const durableHandler = {} as Handler;
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
  const createDurableHandler =
    (method: (typeof methods)[number]) =>
    async (
      request: Parameters<Handler[(typeof methods)[number]]>[0],
      context: Parameters<Handler[(typeof methods)[number]]>[1],
    ) => {
      const response = await emulateHandler[method](request, context);
      // adapter-next queues persistence after producing the response. Await its
      // save before returning so a serverless invocation cannot freeze with an
      // OAuth code only resident in memory.
      let stableTurns = 0;
      while (stableTurns < 3) {
        const revision = persistenceRevision;
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        await pendingPersistence;
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        stableTurns = revision === persistenceRevision ? stableTurns + 1 : 0;
      }
      return response;
    };
  for (const method of methods) {
    durableHandler[method] = createDurableHandler(method);
  }
  return durableHandler;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function handler(environment: NodeJS.ProcessEnv) {
  const emulation = readPreviewProviderEmulation(environment);
  if (!emulation) return;
  if (active?.namespace === emulation.namespace) return active.handler;
  const created = createPreviewEmulateHandler({
    emulation,
    databaseUrl: required(environment.DATABASE_URL, "DATABASE_URL"),
    githubAppPrivateKey: environment.EMULATE_PREVIEW_GITHUB_APP_PRIVATE_KEY,
  });
  active = { namespace: emulation.namespace, handler: created };
  return created;
}

// eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
export async function invokePreviewEmulateRequest(request: Request) {
  const selected = handler(process.env);
  if (!selected) return new Response("Not found", { status: 404 });
  const emulation = readPreviewProviderEmulation(process.env);
  const url = new URL(request.url);
  const prefix = "/api/emulate/";
  if (!emulation || url.origin !== emulation.canonicalOrigin || !url.pathname.startsWith(prefix))
    return new Response("Not found", { status: 404 });
  const path = url.pathname.slice(prefix.length).split("/").filter(Boolean);
  const method = request.method as keyof Handler;
  const selectedMethod = selected[method];
  if (typeof selectedMethod !== "function")
    return new Response("Method not allowed", { status: 405 });
  return selectedMethod(request, { params: Promise.resolve({ path }) });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function previewEmulateRoute(method: keyof Handler) {
  return async (request: Request, context: { params: Promise<{ path: string[] }> }) => {
    try {
      const selected = handler(process.env);
      if (!selected) return new Response("Not found", { status: 404 });
      return await selected[method](request, context);
    } catch {
      return new Response("Preview emulator unavailable", { status: 503 });
    }
  };
}
