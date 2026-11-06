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

const ACTION_RESULT = "action.result";
const TOOL_RESULT = "tool-result";
const DYNAMIC_INITIAL = "dynamic-initial";
const STATIC_HOLD = "static-hold";
const STATIC_IDLE = "static-idle";
const DYNAMIC_IDLE = "dynamic-idle";
const STATIC_RESTORED = "static-restored";
const DYNAMIC_RESTORED = "dynamic-restored";
const STATIC_APPROVAL = "static-approval";
const DYNAMIC_PARALLEL = "dynamic-parallel";
const STATIC_PEER_PRESERVED = "static-peer-preserved";
const STATIC_AFTER_APPROVAL = "static-after-approval";
const SESSION_FAILED = "session.failed";
const TOOL_APPROVAL = "tool-approval";
const INPUT_REQUESTED = "input.requested";
const APPROVE = "approve";

const fixture = async (approval = false) => {
  const root = await mkdtemp(path.join(tmpdir(), "builder-owned-runtime-alignment-"));
  const app = path.join(root, "application");
  await mkdir(path.join(app, "agent/tools"), { recursive: true });
  await symlink(path.resolve("node_modules"), path.join(app, "node_modules"));
  await writeFile(
    path.join(app, "package.json"),
    JSON.stringify({
      dependencies: { eve: "0.68.0", zod: "4.1.5" },
      name: "owned-runtime-alignment",
      private: true,
      type: "module",
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
      output: "stderr",
      port: 0,
      resume,
    });
    const handle = await server.start();
    return new Client({ host: handle.url });
  };
  return {
    app,
    dispose: async () => {
      await server?.close();
      await rm(root, { force: true, recursive: true });
    },
    root,
    start,
    stop: async () => {
      await server?.close();
    },
    writeGeneration,
  };
};
const collect = async (response) => {
  const output = [];
  for await (const event of response) {
    assert.notEqual(event.type, SESSION_FAILED);
    if (event.type === ACTION_RESULT && event.data.result.kind === TOOL_RESULT) {
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
    const created = await client.sessions.create({ message: DYNAMIC_INITIAL });
    const { sessionId } = created.session.state;
    assert.deepEqual(await collect(created.response), {
      count: 1,
      generation: "A",
      nonce: DYNAMIC_INITIAL,
      sessionId,
    });
    const held = collect(await created.session.send(STATIC_HOLD));
    await vi.waitFor(
      async () => {
        await access(path.join(first.root, "started"));
      },
      {
        interval: 20,
        timeout: 30_000,
      },
    );
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
    assert.deepEqual(await held, { count: 2, generation: "A", nonce: STATIC_HOLD, sessionId });
    const next = await collect(await created.session.send(STATIC_IDLE));
    assert.deepEqual(next, { count: 3, generation: "B", nonce: STATIC_IDLE, sessionId });
    assert.deepEqual(await collect(await created.session.send(DYNAMIC_IDLE)), {
      count: 4,
      generation: "B",
      nonce: DYNAMIC_IDLE,
      sessionId,
    });
    await other.writeGeneration("C");
    const parallel = await other.start();
    const parallelCreated = await parallel.sessions.create({ message: DYNAMIC_PARALLEL });
    const parallelOutput = await collect(parallelCreated.response);
    assert.equal(parallelOutput.generation, "C");
    assert.equal(parallelOutput.count, 1);
    assert.notEqual(parallelOutput.sessionId, sessionId);
    await first.stop();
    const resumed = await first.start(true);
    const same = resumed.sessions.attach(sessionId);
    assert.deepEqual(await collect(await same.send(STATIC_RESTORED)), {
      count: 5,
      generation: "B",
      nonce: STATIC_RESTORED,
      sessionId,
    });
    assert.deepEqual(await collect(await same.send(DYNAMIC_RESTORED)), {
      count: 6,
      generation: "B",
      nonce: DYNAMIC_RESTORED,
      sessionId,
    });
    const peer = await collect(await parallelCreated.session.send(STATIC_PEER_PRESERVED));
    assert.equal(peer.generation, "C");
    assert.equal(peer.count, 2);
    const history = await same.snapshot();
    assert.equal(history.session.sessionId, sessionId);
    for (const nonce of [
      "dynamic-initial",
      "static-hold",
      "static-idle",
      "dynamic-idle",
      "static-restored",
      "dynamic-restored",
    ]) {
      assert.ok(
        history.events.some(
          (event) =>
            event.type === ACTION_RESULT &&
            event.data.result.kind === TOOL_RESULT &&
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
    const created = await client.sessions.create({ message: STATIC_APPROVAL });
    const { sessionId } = created.session.state;
    let pending;
    for await (const event of created.response) {
      assert.notEqual(event.type, SESSION_FAILED);
      assert.notEqual(event.type, ACTION_RESULT);
      if (event.type === INPUT_REQUESTED) {
        pending = event.data.requests.find((request) => request.kind === TOOL_APPROVAL);
      }
    }
    assert.ok(pending);
    assert.deepEqual(pending.action.input, { nonce: STATIC_APPROVAL });
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
      await same.respond([{ optionId: APPROVE, requestId: pending.requestId }]),
    );
    assert.deepEqual(approved, { count: 1, generation: "A", nonce: STATIC_APPROVAL, sessionId });
    const afterApproval = await same.snapshot();
    const continuation = restored.sessions.attach(sessionId, {
      streamIndex: afterApproval.session.streamIndex,
    });
    const duplicate = await continuation.respond([
      { optionId: APPROVE, requestId: pending.requestId },
    ]);
    for await (const event of duplicate) {
      assert.notEqual(event.type, ACTION_RESULT);
    }
    const history = await same.snapshot();
    const writes = history.events.filter(
      (event) =>
        event.type === ACTION_RESULT &&
        event.data.result.kind === TOOL_RESULT &&
        event.data.result.output?.nonce === STATIC_APPROVAL,
    );
    assert.equal(writes.length, 1);
    assert.deepEqual(await collect(await continuation.send(STATIC_AFTER_APPROVAL)), {
      count: 2,
      generation: "B",
      nonce: STATIC_AFTER_APPROVAL,
      sessionId,
    });
  } finally {
    await f.dispose();
  }
}, 0);
