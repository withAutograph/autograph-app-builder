import type { SandboxSession } from "eve/sandbox";

const diagnostic = (value: string) =>
  value
    .replaceAll(/https?:\/\/[^\s]+/giu, "[URL REDACTED]")
    .replaceAll(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replaceAll(
      /\b(?<key>authorization|cookie|password|passwd|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$<key>=[REDACTED]",
    )
    .trim()
    .slice(0, 2400);

/** Reinstalls repository dependencies only when replacement compute lacks them. */
export const ensureCheckoutDependencies = async (input: {
  sandbox: Pick<SandboxSession, "run">;
  root: string;
  signal?: AbortSignal;
  requiredExecutable?: string;
}): Promise<{ status: "reused" | "installed" }> => {
  if (
    input.requiredExecutable !== undefined &&
    !/^[A-Za-z0-9_-]{1,80}$/u.test(input.requiredExecutable)
  ) {
    throw new Error("The required repository executable name is invalid.");
  }
  const options = {
    workingDirectory: input.root,
  };
  const runOptions =
    input.signal === undefined ? options : { ...options, abortSignal: input.signal };
  let probe: Awaited<ReturnType<SandboxSession["run"]>>;
  try {
    probe = await input.sandbox.run({
      ...runOptions,
      command:
        input.requiredExecutable === undefined
          ? "test -d node_modules/.bin"
          : `test -x node_modules/.bin/${input.requiredExecutable}`,
    });
  } catch (error) {
    const cause = diagnostic(error instanceof Error ? error.message : String(error));
    throw new Error(
      `Builder could not check repository dependencies in ${input.root}. Check that the selected checkout and sandbox command runner are available, then retry. Cause: ${cause || "The sandbox provider returned no detail."}`,
      { cause: error },
    );
  }
  if (probe.exitCode === 0) {
    return { status: "reused" };
  }
  const command = "bun install --frozen-lockfile";
  let installed: Awaited<ReturnType<SandboxSession["run"]>>;
  try {
    installed = await input.sandbox.run({ ...runOptions, command });
  } catch (error) {
    const cause = diagnostic(error instanceof Error ? error.message : String(error));
    throw new Error(
      `Builder could not restore repository dependencies in ${input.root} with '${command}'. Check Bun, network access, and the repository lockfile, then retry. Cause: ${cause || "The sandbox provider returned no detail."}`,
      { cause: error },
    );
  }
  if (installed.exitCode !== 0) {
    const cause = diagnostic(`${installed.stderr}\n${installed.stdout}`);
    throw new Error(
      `Builder could not restore repository dependencies in ${input.root}: '${command}' exited with status ${installed.exitCode}. Check the lockfile, package resolution, network access, and sandbox free space, then retry. Cause: ${cause || "The command returned no diagnostic output."}`,
    );
  }
  return { status: "installed" };
};
