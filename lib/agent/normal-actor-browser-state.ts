import path from "node:path";
import { z } from "zod";
import type { NormalActorRuntimeProjection } from "../provisioning/hosted-operator-normal-actor-program";

const storageSchema = z.looseObject({
  cookies: z.array(z.looseObject({ domain: z.string(), value: z.string() })),
  origins: z.array(
    z.looseObject({
      origin: z.string(),
      localStorage: z.array(z.looseObject({ value: z.string() })),
    }),
  ),
});

/** Private captured sessions are kept at their actual origin, never adapted to another host. */
export const normalActorBrowserFiles = (
  projection: NormalActorRuntimeProjection,
  stateDirectory: string,
  browserOrigin: string,
) => {
  if (projection.origin !== browserOrigin) {
    throw new Error("normal_actor_browser_origin_mismatch");
  }
  const { hostname } = new URL(browserOrigin);
  const directory = path.posix.join(stateDirectory, "normal-actors");
  const capturedFiles = new Map<string, { path: string; content: string; mode: number }>();
  const privateValues = new Set<string>([directory, projection.origin]);
  const identities = {
    ...projection.identities,
    actors: projection.identities.actors.map((actor) => {
      const destination = path.posix.resolve(directory, actor.storageState);
      // This is the private-file isolation boundary, not a repository-layout constraint.
      if (!destination.startsWith(`${directory}/`)) {
        throw new Error("normal_actor_browser_state_invalid");
      }
      const content = projection.files[actor.storageState];
      if (content === undefined) {
        throw new Error("normal_actor_browser_state_unavailable");
      }
      let storage: z.infer<typeof storageSchema>;
      try {
        storage = storageSchema.parse(JSON.parse(content));
      } catch {
        throw new Error("normal_actor_browser_state_invalid");
      }
      if (
        storage.cookies.some((cookie) => cookie.domain.replace(/^\./u, "") !== hostname) ||
        storage.origins.some((entry) => entry.origin !== browserOrigin)
      ) {
        throw new Error("normal_actor_browser_origin_mismatch");
      }
      for (const value of [
        actor.actorKey,
        actor.actorId,
        actor.organizationId,
        destination,
        content,
        ...storage.cookies.map((cookie) => cookie.value),
        ...storage.origins.flatMap((entry) => entry.localStorage.map((item) => item.value)),
      ]) {
        if (value !== null && value !== "") {
          privateValues.add(value);
        }
      }
      capturedFiles.set(destination, { content, mode: 0o600, path: destination });
      return { ...actor, storageState: destination };
    }),
  };
  const identitiesPath = path.posix.join(directory, "identities.json");
  const identitiesContent = JSON.stringify(identities);
  privateValues.add(identitiesPath);
  privateValues.add(identitiesContent);
  const files = [
    ...capturedFiles.values(),
    { content: identitiesContent, mode: 0o600, path: identitiesPath },
  ];
  return { directory, files, identitiesPath, privateValues, origin: projection.origin };
};
