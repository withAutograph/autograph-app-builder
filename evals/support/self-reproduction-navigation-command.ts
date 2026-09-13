import path from "node:path";

export const navigationReporterOptions = (args: readonly string[]) => {
  const index = args.indexOf("--json-report");
  if (index === -1) return { args: [...args], environment: {} };
  const output = args[index + 1];
  if (!output || !path.isAbsolute(output))
    throw new Error("--json-report requires an absolute output path.");
  return {
    args: [...args.slice(0, index), ...args.slice(index + 2), "--reporter=list,json"],
    environment: { PLAYWRIGHT_JSON_OUTPUT_FILE: output },
  };
};

/** Parse execution options before forwarding only Playwright reporter/test arguments. */
export const navigationDatabaseOptions = (input: readonly string[]) => {
  const args = [...input];
  const take = (name: string) => {
    const index = args.indexOf(name);
    if (index === -1) return;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing ${name} value.`);
    args.splice(index, 2);
    if (args.includes(name)) throw new Error(`Duplicate ${name}.`);
    return value;
  };
  const backend = take("--postgres-backend") ?? "docker";
  const docker = take("--docker");
  const dockerHost = take("--docker-host");
  if (backend !== "docker" && backend !== "process") throw new Error("Invalid PostgreSQL backend.");
  if (
    backend === "docker" &&
    (!docker || !path.isAbsolute(docker) || !dockerHost?.startsWith("unix:///"))
  )
    throw new Error("Use mise run test:production-navigation.");
  return { args, backend, docker, dockerHost };
};
