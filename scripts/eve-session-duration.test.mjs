/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Exercise installed SDK and Nitro build artifact boundaries. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { test } from "vitest";

const sessionRoute = "/eve/v1/session";
const healthRoute = "/eve/v1/health";
const workflowRoute = "/.well-known/workflow/v1/flow";
const sharedServerRoute = "/eve/__server";

const require = createRequire(import.meta.url);
const installed = require.resolve("eve/package.json");
const nativeRoot = process.env.EVE_RECOVERY_NATIVE_ROOT ?? path.dirname(installed);
const load = async (file) =>
  await import(pathToFileURL(path.join(nativeRoot, "dist/src", file)).href);
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
      dev: false,
      handlers: [
        { handler, route: sessionRoute },
        { handler, route: "/eve/v1/session/:id" },
        { handler, route: healthRoute },
        { handler, route: "/eve/v1/**" },
        { handler, route: workflowRoute },
      ],
      logLevel: 0,
      output: { dir: output },
      preset: "vercel",
      rootDir: root,
      scanDirs: [],
      serverDir: false,
      vercel: options,
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
      serviceConfig.routes.find((route) => route.src === sessionRoute).dest,
      sessionRoute,
    );
    assert.equal(
      serviceConfig.routes.find((route) => route.src === "/eve/v1/session/(?<id>[^/]+)").dest,
      sharedServerRoute,
    );
    assert.equal(
      serviceConfig.routes.find((route) => route.src === healthRoute).dest,
      sharedServerRoute,
    );
    assert.equal(firstRoute(serviceConfig.routes, sessionRoute).dest, sessionRoute);
    assert.equal(firstRoute(serviceConfig.routes, "/eve/v1/session/child").dest, sharedServerRoute);
    assert.equal(firstRoute(serviceConfig.routes, healthRoute).dest, sharedServerRoute);
    const shared = await readJson(path.join(output, "functions/eve/__server.func/.vc-config.json"));
    assert.notEqual(shared.maxDuration, 1800);
    const finalFlow = await readJson(flowConfig);
    assert.equal(finalFlow.maxDuration, "max");
    assert.deepEqual(finalFlow.experimentalTriggers, originalFlow.experimentalTriggers);
    assert.equal(originalFlow.experimentalTriggers[0].type, "queue/v2beta");
    assert.equal(
      serviceConfig.routes.find((route) => route.src === workflowRoute).dest,
      workflowRoute,
    );

    // This is the same emitter invoked by withEve during embedded Next configuration.
    await mkdir(path.join(host, ".vercel/output"), { recursive: true });
    await writeFile(path.join(host, ".vercel/project.json"), "{}\n");
    await writeFile(
      path.join(host, ".vercel/output/config.json"),
      JSON.stringify({ routes: [{ dest: "/next-renderer", src: "/(.*)" }], version: 3 }),
    );
    await ensureEveVercelOutputConfig({
      agents: [
        {
          appRoot: host,
          buildCommand: "node node_modules/eve/bin/eve.js build",
          publicRoutePrefix: "",
          servicePrefix: "/_eve_internal/eve",
        },
      ],
      nextRoot: host,
    });
    const embedded = await readJson(path.join(host, ".vercel/output/config.json"));
    const mounted = firstRoute(embedded.routes, sessionRoute);
    assert.deepEqual(mounted.destination, { service: "eve", type: "service" });
    assert.equal(
      path.resolve(host, embedded.services.eve.root, embedded.services.eve.outputDirectory),
      output,
    );
    assert.match(embedded.services.eve.buildCommand, /EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY/u);
    const serviceMount = firstRoute(embedded.services.eve.routes, sessionRoute);
    assert.equal(serviceMount.transforms[0].args, "/eve/v1/$1");
    assert.equal(new RegExp(serviceMount.src, "u").exec(sessionRoute)[1], "session");
    const proofPath = process.env.EVE_SESSION_DURATION_PROOF_PATH;
    if (proofPath !== undefined) {
      // Optional local evidence contains only synthetic artifact configuration.
      const proof = {
        embedded: {
          firstMatchedDestination: mounted.destination,
          outputDirectory: embedded.services.eve.outputDirectory,
          resolvesToTestedOutput:
            path.resolve(
              host,
              embedded.services.eve.root,
              embedded.services.eve.outputDirectory,
            ) === output,
          serviceRoot: embedded.services.eve.root,
        },
        otherProtocol: {
          healthDestination: firstRoute(serviceConfig.routes, healthRoute).dest,
          sessionChildDestination: firstRoute(serviceConfig.routes, "/eve/v1/session/child").dest,
          sharedDurationUnchanged: shared.maxDuration !== 1800,
        },
        session: {
          configPath: path.relative(host, path.join(sessionDir, ".vc-config.json")),
          firstMatchedDestination: firstRoute(serviceConfig.routes, sessionRoute).dest,
          maxDuration: sessionConfig.maxDuration,
          realDirectory: sessionStat.isDirectory(),
          runtime: sessionConfig.runtime,
        },
        workflow: {
          destination: firstRoute(serviceConfig.routes, workflowRoute).dest,
          maxDuration: finalFlow.maxDuration,
          triggersUnchanged: isDeepStrictEqual(
            finalFlow.experimentalTriggers,
            originalFlow.experimentalTriggers,
          ),
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
    { dest: sessionRoute, src: sessionRoute },
    { dest: "/__server", src: sessionRoute },
    { dest: sessionRoute, src: "/eve/v1/session/extra" },
    { dest: sessionRoute, src: "/eve/v1/session/(.*)" },
    { dest: healthRoute, src: healthRoute },
  ]);
  assert.equal(routes[0].dest, sessionRoute);
  for (const route of routes.slice(1)) {
    assert.equal(route.dest, sharedServerRoute);
  }
});
