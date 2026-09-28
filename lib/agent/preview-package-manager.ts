import { z } from "zod";

interface PreviewCommand {
  args: string[];
  executable: string;
}

interface PreviewPackageManagerResolution {
  adjustment?: string;
  command: PreviewCommand;
}

const packageManifest = z.object({ packageManager: z.string().optional() });
const scriptName = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/u;
const packageManagers = new Set(["bun", "npm", "pnpm", "yarn"]);

/** Use the checkout's declared package manager for a simple script launch. */
export const resolvePreviewPackageManager = (
  command: PreviewCommand,
  rootManifest: string | null,
): PreviewPackageManagerResolution => {
  if (rootManifest === null) {
    return { command };
  }
  let declared: string | undefined;
  try {
    const parsed = packageManifest.parse(JSON.parse(rootManifest));
    declared = parsed.packageManager?.split("@")[0];
  } catch {
    throw new Error(
      "The selected repository's package.json is invalid. Repair it before starting a private preview.",
    );
  }
  if (
    declared === undefined ||
    !packageManagers.has(declared) ||
    !packageManagers.has(command.executable) ||
    declared === command.executable
  ) {
    return { command };
  }
  const script = command.args[0] === "run" ? command.args[1] : command.args[0];
  const expectedLength = command.args[0] === "run" ? 2 : 1;
  if (script === undefined || !scriptName.test(script) || command.args.length !== expectedLength) {
    throw new Error(
      `The selected repository declares ${declared} as its package manager, but the preview requested ${command.executable} with arguments that cannot be safely translated. Read its package.json scripts and retry with a ${declared} command.`,
    );
  }
  return {
    adjustment: `Used the repository-declared ${declared} package manager for the ${script} script instead of ${command.executable}.`,
    command: { args: ["run", script], executable: declared },
  };
};
