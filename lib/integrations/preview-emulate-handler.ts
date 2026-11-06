import { setImmediate } from "node:timers/promises";

import { createEmulateHandler } from "@emulators/adapter-next";
import { githubPlugin } from "@emulators/github";
import { vercelPlugin } from "@emulators/vercel";

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
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for Preview emulation.`);
  }
  return value;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPreviewEmulateHandler(input: {
  databaseUrl: string;
  emulation: PreviewProviderEmulation;
  githubAppPrivateKey?: string;
}) {
  const seed = providerEmulationSeed({
    githubAppPrivateKey: input.githubAppPrivateKey,
    githubClientId: input.emulation.githubClientId,
    githubClientSecret: input.emulation.githubClientSecret,
    origin: input.emulation.canonicalOrigin,
    // Dynamic Preview callback origins are intentionally validated by the
    // app's canonical-origin gate rather than a seeded GitHub OAuth app.
    strictGitHubOAuth: false,
    vercelClientId: input.emulation.vercelClientId,
    vercelClientSecret: input.emulation.vercelClientSecret,
  });
  const persistence = createPreviewEmulatePersistence({
    namespace: input.emulation.namespace,
    store: createPostgresPreviewEmulateStateStore(input.databaseUrl),
  });
  let pendingPersistence = Promise.resolve();
  let persistenceRevision = 0;
  const emulateHandler = createEmulateHandler({
    persistence: {
      load: async () => await persistence.load(),
      async save(state) {
        persistenceRevision += 1;
        pendingPersistence = persistence.save(state);
        await pendingPersistence;
      },
    },
    services: {
      github: {
        emulator: githubPlugin,
        seed: seed.github,
      },
      vercel: {
        emulator: vercelPlugin,
        seed: seed.vercel,
      },
    },
  });
  const durableMethod =
    (method: keyof Handler) =>
    async (
      request: Parameters<Handler[keyof Handler]>[0],
      context: Parameters<Handler[keyof Handler]>[1],
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
        await setImmediate();
        stableTurns = revision === persistenceRevision ? stableTurns + 1 : 0;
      }
      return response;
    };
  const durableHandlers: Handler = {
    DELETE: durableMethod("DELETE"),
    GET: durableMethod("GET"),
    PATCH: durableMethod("PATCH"),
    POST: durableMethod("POST"),
    PUT: durableMethod("PUT"),
  };
  return durableHandlers;
}

const supportedMethods = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const isSupportedMethod = (method: string): method is keyof Handler => supportedMethods.has(method);

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function handler(environment: NodeJS.ProcessEnv): Handler | undefined {
  const emulation = readPreviewProviderEmulation(environment);
  if (!emulation) {
    return undefined;
  }
  if (active?.namespace === emulation.namespace) {
    return active.handler;
  }
  const created = createPreviewEmulateHandler({
    databaseUrl: required(environment.DATABASE_URL, "DATABASE_URL"),
    emulation,
    githubAppPrivateKey: environment.EMULATE_PREVIEW_GITHUB_APP_PRIVATE_KEY,
  });
  active = { handler: created, namespace: emulation.namespace };
  return created;
}

// eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
export async function invokePreviewEmulateRequest(request: Request) {
  const selected = handler(process.env);
  if (!selected) {
    return new Response("Not found", { status: 404 });
  }
  const emulation = readPreviewProviderEmulation(process.env);
  const url = new URL(request.url);
  const prefix = "/api/emulate/";
  if (!emulation || url.origin !== emulation.canonicalOrigin || !url.pathname.startsWith(prefix)) {
    return new Response("Not found", { status: 404 });
  }
  const path = url.pathname.slice(prefix.length).split("/").filter(Boolean);
  const { method } = request;
  if (!isSupportedMethod(method)) {
    return new Response("Method not allowed", { status: 405 });
  }
  return await selected[method](request, { params: Promise.resolve({ path }) });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function previewEmulateRoute(method: keyof Handler) {
  return async (request: Request, context: { params: Promise<{ path: string[] }> }) => {
    try {
      const selected = handler(process.env);
      if (!selected) {
        return new Response("Not found", { status: 404 });
      }
      return await selected[method](request, context);
    } catch {
      return new Response("Preview emulator unavailable", { status: 503 });
    }
  };
}
