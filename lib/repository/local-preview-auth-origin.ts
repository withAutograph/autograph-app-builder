import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";
import { localRuntimeEnvironmentPath } from "./runtime-environment";

const recordedOriginPattern = /^(?:http:\/\/localhost:3000|https:\/\/[a-z0-9-]+\.vercel\.run)$/u;
const recordedOrigin = z.string().regex(recordedOriginPattern);
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

export const localPreviewAuthOriginReadProgram = (file: string, optionalBrowserOrigin = false) =>
  String.raw`
const fs = require("node:fs");
const path = require("node:path");
const file = ${JSON.stringify(file)};
const directory = path.dirname(file);
const optional = ${JSON.stringify(optionalBrowserOrigin)};
for (const name of [directory, file]) {
  const stat = fs.lstatSync(name, { throwIfNoEntry: false });
  if (stat === undefined && optional) {
    console.log("null");
    process.exit(0);
  }
  if (!stat || (name === directory ? !stat.isDirectory() : !stat.isFile()) ||
      stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Local runtime ownership changed");
  }
}
if (fs.realpathSync(directory) !== directory) throw new Error("Local runtime path changed");
const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
let env;
try {
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Local runtime ownership changed");
  }
  env = JSON.parse(fs.readFileSync(descriptor, "utf8"));
} finally {
  fs.closeSync(descriptor);
}
const origin = env.BETTER_AUTH_URL;
if (optional && (origin !== env.APP_TEST_BASE_URL ||
    typeof origin !== "string" || !${recordedOriginPattern}.test(origin))) {
  throw new Error("Local browser origin changed");
}
console.log(JSON.stringify(origin));
`;

interface ReadLocalAuthOriginInput {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run">;
  signal?: AbortSignal;
}

const readOwnedLocalOrigin = async <T>(
  input: ReadLocalAuthOriginInput,
  optionalBrowserOrigin: boolean,
  schema: z.ZodType<T>,
): Promise<T> => {
  input.signal?.throwIfAborted();
  const file = localRuntimeEnvironmentPath(input.root, input.appId);
  const source = localPreviewAuthOriginReadProgram(file, optionalBrowserOrigin);
  const options: Parameters<typeof input.sandbox.run>[0] = {
    command: `node -e ${quote(source)}`,
    workingDirectory: input.root,
  };
  if (input.signal !== undefined) {
    options.abortSignal = input.signal;
  }
  const result = await input.sandbox.run({
    ...options,
  });
  input.signal?.throwIfAborted();
  if (result.exitCode !== 0) {
    throw new Error("The owned local Auth origin could not be read for preview reconciliation.");
  }
  return schema.parse(JSON.parse(result.stdout));
};

/** Read only the previous origin from the exact server-owned local runtime file. */
export const readLocalPreviewAuthOrigin = async (
  input: ReadLocalAuthOriginInput,
): Promise<string> => await readOwnedLocalOrigin(input, false, recordedOrigin);

/** A missing local runtime is valid for apps with an ordinary browser server. */
export const readOptionalLocalBrowserAuthOrigin = async (
  input: ReadLocalAuthOriginInput,
): Promise<string | null> => await readOwnedLocalOrigin(input, true, recordedOrigin.nullable());
