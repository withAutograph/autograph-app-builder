import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createConnection } from "node:net";
import { once } from "node:events";
import { z } from "zod";
import { readSelectedDevelopmentDependencies } from "./application-dependencies";
import { refreshDevelopmentApplication } from "./application-root";

const unavailable = () => new Error("The selected local Builder cycle cannot be resumed safely.");
const ownedDirectory = async (directory: string, privateRoot = false) => {
  const info = await lstat(directory);
  // oxlint-disable-next-line eslint/no-bitwise -- Restrict the authority root to its local OS owner.
  const privateMode = (info.mode & 0o077) === 0;
  const valid = [
    info.isDirectory(),
    !info.isSymbolicLink(),
    info.uid === process.getuid?.(),
    !privateRoot || privateMode,
    (await realpath(directory)) === directory,
  ].every(Boolean);
  if (!valid) {
    throw unavailable();
  }
};
const portStopped = async (port: number) => {
  z.number().int().min(1024).max(65_535).parse(port);
  const socket = createConnection({ host: "127.0.0.1", port });
  let occupied = false;
  try {
    await once(socket, "connect");
    occupied = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ECONNREFUSED") {
      throw unavailable();
    }
  } finally {
    socket.destroy();
  }
  if (occupied) {
    throw new Error("Stop this local Builder instance before resuming its saved cycle.");
  }
};

const stopped = async (applicationRoot: string, selectedPort: number) => {
  const file = path.join(applicationRoot, ".eve/dev-server-state.v1.json");
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  // Eve removes its server marker on orderly shutdown. Probe the explicitly selected
  // port in that case; never invent a persisted endpoint or restore the marker.
  if (info === undefined) {
    await portStopped(selectedPort);
    return;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) {
    throw unavailable();
  }
  const { url } = z.object({ url: z.url() }).parse(JSON.parse(await readFile(file, "utf-8")));
  const endpoint = new URL(url);
  const port = Number(endpoint.port);
  const valid = [
    endpoint.protocol === "http:",
    endpoint.hostname === "127.0.0.1",
    endpoint.username === "",
    endpoint.password === "",
    Number.isInteger(port),
    port >= 1024,
    port <= 65_535,
    endpoint.pathname === "/",
    endpoint.search === "",
    endpoint.hash === "",
  ].every(Boolean);
  if (!valid) {
    throw unavailable();
  }
  await portStopped(port);
  if (port !== selectedPort) {
    await portStopped(selectedPort);
  }
};

/** Explicit same-instance local recovery. Retains actual Eve state; never imports hosted checkpoints or another instance's state. */
export const resumeDevelopmentCycle = async (input: {
  repositoryRoot: string;
  runsRoot: string;
  cycleRoot: string;
  evePort: number;
}) => {
  const runsRoot = await realpath(input.runsRoot);
  await ownedDirectory(runsRoot, true);
  if (!path.isAbsolute(input.cycleRoot) || path.resolve(input.cycleRoot) !== input.cycleRoot) {
    throw unavailable();
  }
  const root = input.cycleRoot;
  const supervisor = path.dirname(root);
  if (
    path.dirname(supervisor) !== runsRoot ||
    !path.basename(supervisor).startsWith("supervisor-") ||
    !path.basename(root).startsWith("cycle-")
  ) {
    throw unavailable();
  }
  await ownedDirectory(supervisor, true);
  await ownedDirectory(root, true);
  const applicationRoot = path.join(root, "eve-application/source");
  const runtimeHome = path.join(root, "home");
  const workflowData = path.join(root, "workflow-data");
  await ownedDirectory(path.dirname(applicationRoot), true);
  await ownedDirectory(applicationRoot, true);
  await ownedDirectory(runtimeHome, true);
  await ownedDirectory(workflowData, true);
  await ownedDirectory(path.join(applicationRoot, ".eve"));
  await ownedDirectory(path.join(applicationRoot, ".eve/.workflow-data"));
  // The entrypoint holds the existing kernel advisory lock for the entire state
  // root, including recovery. A second sentinel file would survive interruption
  // and cannot establish whether a local process still owns the cycle.
  await stopped(applicationRoot, input.evePort);
  await refreshDevelopmentApplication({
    applicationRoot,
    repositoryRoot: input.repositoryRoot,
    runRoot: root,
  });
  const dependencyBinding = await readSelectedDevelopmentDependencies(input.repositoryRoot);
  return {
    application: { root: applicationRoot },
    dependencyBinding,
    root,
    runtimeHome,
    workflowData,
  };
};
