import { pathToFileURL } from "node:url";

import {
  buildImage,
  inspectLocalImage,
  loginGhcr,
  inspectRemoteImage,
  preloadImage,
  prepareProofRuntime,
  proveSandboxImage,
  pushImage,
  verifyImageSources,
  type LifecycleApproval,
} from "../../../../lib/image/node-lifecycle.ts";

export type ImageLifecycleAction =
  | "verify-sources"
  | "build"
  | "inspect-local"
  | "login"
  | "push"
  | "inspect-remote"
  | "preload"
  | "prepare-proof-runtime"
  | "prove";

export function parseLifecycleArguments(
  action: ImageLifecycleAction,
  args: readonly string[],
): Readonly<{
  approval: LifecycleApproval;
  image?: string;
  username?: string;
}> {
  const entries = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--"))
      throw new Error(
        "Image lifecycle arguments must be exact --name value pairs.",
      );
    if (entries.has(flag))
      throw new Error(`Duplicate image lifecycle argument ${flag}.`);
    entries.set(flag, value);
  }
  const required = (flag: string) => {
    const value = entries.get(flag);
    if (value === undefined || value === "")
      throw new Error(`Missing required image lifecycle argument ${flag}.`);
    entries.delete(flag);
    return value;
  };
  const approval: LifecycleApproval = {
    arrustedRoot: required("--arrusted-root"),
    stateRoot: required("--state-root"),
    builderCommit: required("--builder-commit"),
    builderTree: required("--builder-tree"),
    dockerfileSha256: required("--dockerfile-sha256"),
  };
  const image =
    action === "preload" || action === "prove"
      ? required("--image")
      : undefined;
  const username = action === "login" ? required("--username") : undefined;
  if (entries.size !== 0)
    throw new Error(
      `Unknown image lifecycle arguments: ${[...entries.keys()].join(", ")}.`,
    );
  return {
    approval,
    ...(image === undefined ? {} : { image }),
    ...(username === undefined ? {} : { username }),
  };
}

export async function runImageLifecycleTask(
  action: ImageLifecycleAction,
  args: readonly string[],
): Promise<unknown> {
  const { approval, image, username } = parseLifecycleArguments(action, args);
  if (action === "verify-sources") return verifyImageSources(approval);
  if (action === "build") return buildImage(approval);
  if (action === "inspect-local") return inspectLocalImage(approval);
  if (action === "login") return loginGhcr(approval, username!);
  if (action === "push") return pushImage(approval);
  if (action === "inspect-remote") return inspectRemoteImage(approval);
  if (action === "preload") return preloadImage(approval, image!);
  if (action === "prepare-proof-runtime") return prepareProofRuntime(approval);
  return proveSandboxImage(approval, image!);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  const action = process.argv[2] as ImageLifecycleAction | undefined;
  if (
    action === undefined ||
    ![
      "verify-sources",
      "build",
      "inspect-local",
      "login",
      "push",
      "inspect-remote",
      "preload",
      "prepare-proof-runtime",
      "prove",
    ].includes(action)
  )
    throw new Error(
      "Usage: image-lifecycle.ts <verify-sources|build|inspect-local|login|push|inspect-remote|preload|prepare-proof-runtime|prove> <exact arguments>",
    );
  console.log(
    JSON.stringify(
      await runImageLifecycleTask(action, process.argv.slice(3)),
      null,
      2,
    ),
  );
}
