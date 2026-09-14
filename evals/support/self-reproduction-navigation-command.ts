import path from "node:path";

export const navigationReporterOptions = (args: readonly string[]) => {
  const index = args.indexOf("--json-report");
  if (index === -1) {return { args: [...args], environment: {} };}
  const output = args[index + 1];
  if (!output || !path.isAbsolute(output))
    {throw new Error("--json-report requires an absolute output path.");}
  return {
    args: [...args.slice(0, index), ...args.slice(index + 2), "--reporter=list,json"],
    environment: { PLAYWRIGHT_JSON_OUTPUT_FILE: output },
  };
};
