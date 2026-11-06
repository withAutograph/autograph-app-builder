import nodeProcess from "node:process";

const { runLocalEve } = await import("../../../../lib/eve/local-eve-launch");

const resume = nodeProcess.argv.length === 3 && nodeProcess.argv[2] === "--resume";
if (nodeProcess.argv.length !== 2 && !resume) {
  throw new Error("The local development Eve entrypoint accepts only explicit --resume.");
}

nodeProcess.exitCode = await runLocalEve({
  repositoryRoot: new URL("../../../../", import.meta.url).pathname,

  resume,
});
