/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Exercise installed SDK and Nitro build artifact boundaries. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { test } from "vitest";

const EVE_SESSION_PATH = "/eve/v1/session";
const EVE_HEALTH_PATH = "/eve/v1/health";
const WORKFLOW_FLOW_PATH = "/.well-known/workflow/v1/flow";
const EVE_SERVER_PATH = "/eve/__server";

const require = createRequire(import.meta.url);
const installed = require.resolve("eve/package.json");
const nativeRoot = process.env.EVE_RECOVERY_NATIVE_ROOT ?? path.dirname(installed);
const load = (file) => import(pathToFileURL(path.join(nativeRoot, "dist/src", file)).href);
const { createEveVercelOptions } = await load("internal/nitro/host/vercel-build-output-config.js");
const { normalizeEveVercelRoutes } = await load(
  "internal/workflow-bundle/eve-service-route-output.js",
);
const { materializeVercelWorkflowFunctionOutput, normalizeEveVercelFunctionOutput } = await load(
  "internal/workflow-bundle/vercel-workflow-output.js",
);
const { ensureEveVercelOutputConfig } = await load("public/next/vercel-output-config.js");
const { createNitro, prepare, build } = await import(
  pathToFileURL(createRequire(installed).resolve("nitro/builder")).href
);
const firstRoute = (routes, pathname) =>
  routes.find(
    (route) => route.src !== undefined && new RegExp(`^(?:${route.src})$`, "u").test(pathname),
  );
const readJson = async (file) => JSON.parse(await readFile(file, "utf-8"));

test("embedded Eve service routes only session creation to its real 1800-second Vercel function", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eve-session-duration-"));
  let nitro;
  try {
    const host = path.join(root, "host");
    const output = path.join(host, ".eve/vercel-services/eve/.vercel/output");
    const handler = path.join(root, "handler.mjs");
    await mkdir(host, { recursive: true });
    await writeFile(handler, 'export default () => "local artifact fixture";\n');
    const options = createEveVercelOptions({ agentName: "duration-fixture", enabled: true });
    nitro = await createNitro({
      rootDir: root,
      serverDir: false,
      scanDirs: [],
      preset: "vercel",
      dev: false,
      logLevel: 0,
      output: { dir: output },
      vercel: options,
      handlers: [
        { route: EVE_SESSION_PATH, handler },
        { route: "/eve/v1/session/:id", handler },
        { route: EVE_HEALTH_PATH, handler },
        { route: "/eve/v1/**", handler },
        { route: WORKFLOW_FLOW_PATH, handler },
      ],
    });
    await prepare(nitro);
    await build(nitro);
    const flowConfig = path.join(
      output,
      "functions/.well-known/workflow/v1/flow.func/.vc-config.json",
    );
    const originalFlow = await readJson(flowConfig);
    await materializeVercelWorkflowFunctionOutput(output);
    await normalizeEveVercelFunctionOutput(output);
    const sessionDir = path.join(output, "functions/eve/v1/session.func");
    const sessionStat = await lstat(sessionDir);
    assert.equal(sessionStat.isDirectory(), true);
    const sessionConfig = await readJson(path.join(sessionDir, ".vc-config.json"));
    assert.equal(sessionConfig.maxDuration, 1800);
    assert.equal(sessionConfig.runtime, "nodejs24.x");
    const serviceConfig = await readJson(path.join(output, "config.json"));
    assert.equal(
      serviceConfig.routes.find((route) => route.src === EVE_SESSION_PATH).dest,
      EVE_SESSION_PATH,
    );
    assert.equal(
      serviceConfig.routes.find((route) => route.src === "/eve/v1/session/(?<id>[^/]+)").dest,
      EVE_SERVER_PATH,
    );
    assert.equal(
      serviceConfig.routes.find((route) => route.src === EVE_HEALTH_PATH).dest,
      EVE_SERVER_PATH,
    );
    assert.equal(firstRoute(serviceConfig.routes, EVE_SESSION_PATH).dest, EVE_SESSION_PATH);
    assert.equal(firstRoute(serviceConfig.routes, "/eve/v1/session/child").dest, EVE_SERVER_PATH);
    assert.equal(firstRoute(serviceConfig.routes, EVE_HEALTH_PATH).dest, EVE_SERVER_PATH);
    const shared = await readJson(path.join(output, "functions/eve/__server.func/.vc-config.json"));
    assert.notEqual(shared.maxDuration, 1800);
    const finalFlow = await readJson(flowConfig);
    assert.equal(finalFlow.maxDuration, "max");
    assert.deepEqual(finalFlow.experimentalTriggers, originalFlow.experimentalTriggers);
    assert.equal(originalFlow.experimentalTriggers[0].type, "queue/v2beta");
    assert.equal(
      serviceConfig.routes.find((route) => route.src === WORKFLOW_FLOW_PATH).dest,
      WORKFLOW_FLOW_PATH,
    );

    // This is the same emitter invoked by withEve during embedded Next configuration.
    await mkdir(path.join(host, ".vercel/output"), { recursive: true });
    await writeFile(path.join(host, ".vercel/project.json"), "{}\n");
    await writeFile(
      path.join(host, ".vercel/output/config.json"),
      JSON.stringify({ version: 3, routes: [{ src: "/(.*)", dest: "/next-renderer" }] }),
    );
    await ensureEveVercelOutputConfig({
      nextRoot: host,
      agents: [
        {
          appRoot: host,
          buildCommand: "node node_modules/eve/bin/eve.js build",
          publicRoutePrefix: "",
          servicePrefix: "/_eve_internal/eve",
        },
      ],
    });
    const embedded = await readJson(path.join(host, ".vercel/output/config.json"));
    const mounted = firstRoute(embedded.routes, EVE_SESSION_PATH);
    assert.deepEqual(mounted.destination, { service: "eve", type: "service" });
    assert.equal(
      path.resolve(host, embedded.services.eve.root, embedded.services.eve.outputDirectory),
      output,
    );
    assert.match(embedded.services.eve.buildCommand, /EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY/u);
    const serviceMount = firstRoute(embedded.services.eve.routes, EVE_SESSION_PATH);
    assert.equal(serviceMount.transforms[0].args, "/eve/v1/$1");
    assert.equal(new RegExp(serviceMount.src, "u").exec(EVE_SESSION_PATH)[1], "session");
    const proofPath = process.env.EVE_SESSION_DURATION_PROOF_PATH;
    if (proofPath !== undefined) {
      // Optional local evidence contains only synthetic artifact configuration.
      const proof = {
        session: {
          configPath: path.relative(host, path.join(sessionDir, ".vc-config.json")),
          runtime: sessionConfig.runtime,
          maxDuration: sessionConfig.maxDuration,
          realDirectory: sessionStat.isDirectory(),
          firstMatchedDestination: firstRoute(serviceConfig.routes, EVE_SESSION_PATH).dest,
        },
        otherProtocol: {
          sessionChildDestination: firstRoute(serviceConfig.routes, "/eve/v1/session/child").dest,
          healthDestination: firstRoute(serviceConfig.routes, EVE_HEALTH_PATH).dest,
          sharedDurationUnchanged: shared.maxDuration !== 1800,
        },
        workflow: {
          maxDuration: finalFlow.maxDuration,
          triggersUnchanged: isDeepStrictEqual(
            finalFlow.experimentalTriggers,
            originalFlow.experimentalTriggers,
          ),
          destination: firstRoute(serviceConfig.routes, WORKFLOW_FLOW_PATH).dest,
        },
        embedded: {
          firstMatchedDestination: mounted.destination,
          serviceRoot: embedded.services.eve.root,
          outputDirectory: embedded.services.eve.outputDirectory,
          resolvesToTestedOutput:
            path.resolve(
              host,
              embedded.services.eve.root,
              embedded.services.eve.outputDirectory,
            ) === output,
        },
      };
      await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    }
  } finally {
    await nitro?.close();
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

test("only the exact session function destination survives protocol normalization", () => {
  const routes = normalizeEveVercelRoutes([
    { dest: EVE_SESSION_PATH, src: EVE_SESSION_PATH },
    { dest: "/__server", src: EVE_SESSION_PATH },
    { dest: EVE_SESSION_PATH, src: "/eve/v1/session/extra" },
    { dest: EVE_SESSION_PATH, src: "/eve/v1/session/(.*)" },
    { dest: EVE_HEALTH_PATH, src: EVE_HEALTH_PATH },
  ]);
  assert.equal(routes[0].dest, EVE_SESSION_PATH);
  for (const route of routes.slice(1)) {
    assert.equal(route.dest, EVE_SERVER_PATH);
  }
});
