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
  return createEmulateHandler({
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
    persistence: createPreviewEmulatePersistence({
      namespace: input.emulation.namespace,
      store: createPostgresPreviewEmulateStateStore(input.databaseUrl),
    }),
  });
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
