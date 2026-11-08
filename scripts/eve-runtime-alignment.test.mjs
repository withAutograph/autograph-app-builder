/* oxlint-disable sonarjs/publicly-writable-directories -- mkdtemp creates each owned disposable fixture; cleanup only removes those roots. */
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-return -- Qualify installed Eve JavaScript APIs through actual owned local HTTP turns. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
import { test, vi } from "vitest";
import { z } from "zod";

const require = createRequire(import.meta.url);
const sdk = path.dirname(require.resolve("eve/package.json"));
const { createDevelopmentServer } = await import(
  pathToFileURL(path.join(sdk, "dist/src/cli/dev/local-server-process.js")).href
);
const { readActiveDevelopmentRuntimeArtifactsSnapshot } = await import(
  pathToFileURL(path.join(sdk, "dist/src/internal/nitro/dev-runtime-artifacts.js")).href
);
const { Client } = await import("eve/client");

const fixture = async (approval = false) => {
  const root = await mkdtemp(path.join(tmpdir(), "builder-owned-runtime-alignment-"));
  const app = path.join(root, "application");
  await mkdir(path.join(app, "agent/tools"), { recursive: true });
  await symlink(path.resolve("node_modules"), path.join(app, "node_modules"));
  await writeFile(
    path.join(app, "package.json"),
    JSON.stringify({
      name: "owned-runtime-alignment",
      private: true,
      type: "module",
      dependencies: { eve: "0.68.0", zod: "4.1.5" },
    }),
  );
  await writeFile(
    path.join(app, "agent/instructions.md"),
    "Call only the requested proof tool. There are no provider operations.",
  );
  await writeFile(
    path.join(app, "agent/agent.ts"),
    `import {defineAgent} from 'eve';import {mockModel} from 'eve/evals';export default defineAgent({modelContextWindowTokens:100000,model:mockModel(({lastUserMessage,toolResults})=>{const nonce=lastUserMessage??'none';if(!/^(static|dynamic)-[a-z-]+$/.test(nonce))return 'No requested proof operation';if(toolResults.some(r=>r.output&&JSON.stringify(r.output).includes(nonce)))return 'complete '+nonce;return {toolCalls:[{name:nonce.startsWith('dynamic')?'dynamic_probe':'static_probe',input:{nonce}}]};})});`,
  );
  await writeFile(
    path.join(app, "agent/counter.ts"),
    `import {defineState} from 'eve/context';export const counter=defineState('alignment.counter',()=>0);`,
  );
  const writeGeneration = async (generation) => {
    const body = `import {defineTool,defineDynamic} from 'eve/tools';import {z} from 'zod';import {access,writeFile} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';import {counter} from '../counter';const probe=defineTool({description:'Owned local runtime proof',${approval ? "approval:(ctx)=>ctx.toolInput?.nonce==='static-approval'," : ""}inputSchema:z.object({nonce:z.string()}),execute:async(input,ctx)=>{if(input.nonce==='static-hold'){await writeFile(${JSON.stringify(path.join(root, "started"))},'started');while(true){ctx.abortSignal.throwIfAborted();try{await access(${JSON.stringify(path.join(root, "release"))});break;}catch{await delay(20);}}}counter.update(n=>n+1);return {generation:${JSON.stringify(generation)},nonce:input.nonce,count:counter.get(),sessionId:ctx.session.id};}});`;
    await writeFile(path.join(app, "agent/tools/static_probe.ts"), `${body}export default probe;`);
    await writeFile(
      path.join(app, "agent/tools/dynamic_probe.ts"),
      `${body}export default defineDynamic({events:{'turn.started':()=>probe}});`,
    );
  };
  let server;
  const start = async (resume = false) => {
    server = createDevelopmentServer(app, {
      developmentExtensions: { enabled: [] },
      existing: "reject",
      host: "127.0.0.1",
      port: 0,
      output: "stderr",
      resume,
    });
    const handle = await server.start();
    return new Client({ host: handle.url });
  };
  return {
    root,
    app,
    writeGeneration,
    start,
    stop: async () => {
      await server?.close();
    },
    dispose: async () => {
      await server?.close();
      await rm(root, { force: true, recursive: true });
    },
  };
};
const actionResultEvent = "action.result";
const toolResultKind = "tool-result";
const dynamicInitial = "dynamic-initial";
const staticHold = "static-hold";
const staticIdle = "static-idle";
const dynamicIdle = "dynamic-idle";
const staticRestored = "static-restored";
const dynamicRestored = "dynamic-restored";
const staticApproval = "static-approval";

const collect = async (response) => {
  const output = [];
  for await (const event of response) {
    assert.notEqual(event.type, "session.failed");
    if (event.type === actionResultEvent && event.data.result.kind === toolResultKind) {
      assert.equal(event.data.status, "completed");
      assert.notEqual(event.data.result.isError, true);
      output.push(event.data.result.output);
    }
  }
  assert.equal(output.length, 1, "A real tool dispatch must occur in this turn");
  return output[0];
};

test("actual Eve keeps in-flight A, dispatches idle B static/dynamic, restores the same session, and isolates a parallel instance", async () => {
  const first = await fixture();
  const other = await fixture();
  try {
    await first.writeGeneration("A");
    const client = await first.start();
    const created = await client.sessions.create({ message: dynamicInitial });
    const { sessionId } = created.session.state;
    assert.deepEqual(await collect(created.response), {
      count: 1,
      generation: "A",
      nonce: dynamicInitial,
      sessionId,
    });
    const held = collect(await created.session.send(staticHold));
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    await vi.waitFor(() => access(path.join(first.root, "started")), {
      interval: 20,
      timeout: 30_000,
    });
    const before = z
      .string()
      .min(1)
      .parse(readActiveDevelopmentRuntimeArtifactsSnapshot(first.app)?.runtimeAppRoot);
    assert.ok(before);
    await first.writeGeneration("B");
    await vi.waitFor(
      () => {
        assert.notEqual(
          readActiveDevelopmentRuntimeArtifactsSnapshot(first.app)?.runtimeAppRoot,
          before,
        );
      },
      { interval: 50, timeout: 60_000 },
    );
    await writeFile(path.join(first.root, "release"), "release");
    assert.deepEqual(await held, { count: 2, generation: "A", nonce: staticHold, sessionId });
    const next = await collect(await created.session.send(staticIdle));
    assert.deepEqual(next, { count: 3, generation: "B", nonce: staticIdle, sessionId });
    assert.deepEqual(await collect(await created.session.send(dynamicIdle)), {
      count: 4,
      generation: "B",
      nonce: dynamicIdle,
      sessionId,
    });
    await other.writeGeneration("C");
    const parallel = await other.start();
    const parallelCreated = await parallel.sessions.create({ message: "dynamic-parallel" });
    const parallelOutput = await collect(parallelCreated.response);
    assert.equal(parallelOutput.generation, "C");
    assert.equal(parallelOutput.count, 1);
    assert.notEqual(parallelOutput.sessionId, sessionId);
    await first.stop();
    const resumed = await first.start(true);
    const same = resumed.sessions.attach(sessionId);
    assert.deepEqual(await collect(await same.send(staticRestored)), {
      count: 5,
      generation: "B",
      nonce: staticRestored,
      sessionId,
    });
    assert.deepEqual(await collect(await same.send(dynamicRestored)), {
      count: 6,
      generation: "B",
      nonce: dynamicRestored,
      sessionId,
    });
    const peer = await collect(await parallelCreated.session.send("static-peer-preserved"));
    assert.equal(peer.generation, "C");
    assert.equal(peer.count, 2);
    const history = await same.snapshot();
    assert.equal(history.session.sessionId, sessionId);
    for (const nonce of [
      dynamicInitial,
      staticHold,
      staticIdle,
      dynamicIdle,
      staticRestored,
      dynamicRestored,
    ]) {
      assert.ok(
        history.events.some(
          (event) =>
            event.type === actionResultEvent &&
            event.data.result.kind === toolResultKind &&
            event.data.result.output?.nonce === nonce,
        ),
      );
    }
  } finally {
    await Promise.all([first.dispose(), other.dispose()]);
  }
}, 0);

test("actual pending approval survives B activation and restore with its A executable and cannot dispatch twice", async () => {
  const f = await fixture(true);
  try {
    await f.writeGeneration("A");
    const client = await f.start();
    const created = await client.sessions.create({ message: staticApproval });
    const { sessionId } = created.session.state;
    let pending;
    for await (const event of created.response) {
      assert.notEqual(event.type, "session.failed");
      assert.notEqual(event.type, actionResultEvent);
      if (event.type === "input.requested") {
        pending = event.data.requests.find((request) => request.kind === "tool-approval");
      }
    }
    assert.ok(pending);
    assert.deepEqual(pending.action.input, { nonce: staticApproval });
    const prior = readActiveDevelopmentRuntimeArtifactsSnapshot(f.app)?.runtimeAppRoot;
    await f.writeGeneration("B");
    await vi.waitFor(
      () => {
        assert.notEqual(
          readActiveDevelopmentRuntimeArtifactsSnapshot(f.app)?.runtimeAppRoot,
          prior,
        );
      },
      { interval: 50, timeout: 60_000 },
    );
    await f.stop();
    const restored = await f.start(true);
    const retained = await restored.sessions.attach(sessionId).snapshot();
    const same = restored.sessions.attach(sessionId, { streamIndex: retained.session.streamIndex });
    const approved = await collect(
      await same.respond([{ requestId: pending.requestId, optionId: "approve" }]),
    );
    assert.deepEqual(approved, { count: 1, generation: "A", nonce: staticApproval, sessionId });
    const afterApproval = await same.snapshot();
    const continuation = restored.sessions.attach(sessionId, {
      streamIndex: afterApproval.session.streamIndex,
    });
    const duplicate = await continuation.respond([
      { requestId: pending.requestId, optionId: "approve" },
    ]);
    for await (const event of duplicate) {
      assert.notEqual(event.type, actionResultEvent);
    }
    const history = await same.snapshot();
    const writes = history.events.filter(
      (event) =>
        event.type === actionResultEvent &&
        event.data.result.kind === toolResultKind &&
        event.data.result.output?.nonce === staticApproval,
    );
    assert.equal(writes.length, 1);
    assert.deepEqual(await collect(await continuation.send("static-after-approval")), {
      count: 2,
      generation: "B",
      nonce: "static-after-approval",
      sessionId,
    });
  } finally {
    await f.dispose();
  }
}, 0);
