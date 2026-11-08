/* oxlint-disable eslint/no-await-in-loop -- Public protocol calls are intentionally observed in dispatch order. */
import { afterEach, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { tmpdir } from "node:os";
import { connectHostedSession, hostedSessionTools } from "./hosted-session-client";

const owned: string[] = [];
afterEach(async () => {
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
  await Promise.all(owned.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const fixture = async (mode = "normal") => {
  const root = await mkdtemp(path.join(tmpdir(), "builder-native-protocol-"));
  owned.push(root);
  const cwd = path.join(root, "state");
  await mkdir(cwd);
  const trace = path.join(root, "trace");
  const bin = path.join(root, "codex");
  await writeFile(
    bin,
    `#!${process.execPath}
const {createInterface} = require('node:readline');
const {appendFileSync} = require('node:fs');
const trace = ${JSON.stringify(trace)};
const record = value => appendFileSync(trace, JSON.stringify(value)+'\\n');
record({args:process.argv.slice(2),cwd:process.cwd(),pid:process.pid});
const tools = ${JSON.stringify(hostedSessionTools)}.map(name=>({name,description:'upstream '+name,inputSchema:{type:'object'},_meta:{fixture:true}}));
let ready = false;
const send=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const msg = JSON.parse(line); record(msg);
 if(msg.method==='initialize') { if(${JSON.stringify(mode)}!=='stall') send(msg.id,{}); }
 else if(msg.method==='thread/start') send(msg.id,{thread:{id:'ephemeral-native-thread'}});
 else if(msg.method==='mcpServerStatus/list') {
   const runtimeStatus = ${JSON.stringify(mode)}==='auth'?'authenticationRequired':ready?'connected':'starting'; ready=true;
   send(msg.id,{data:[{name:'a511-original',runtimeStatus,httpOrigin:${JSON.stringify(mode === "origin" ? "https://wrong.example" : "https://builder.example")},toolsError:null,tools:Object.fromEntries([...tools,{name:'private_tool',inputSchema:{type:'object'}}].map(t=>[t.name,t]))}],nextCursor:null});
 } else if(msg.method==='mcpServer/tool/call') {
   if(${JSON.stringify(mode)}==='error') process.stdout.write(JSON.stringify({id:msg.id,error:{code:-1,message:'private-secret-never-log'}})+'\\n');
   else send(msg.id,{content:[{type:'text',text:'public result'}],structuredContent:{cursor:1955,sessionId:msg.params.arguments.sessionId},_meta:{upstream:true}});
 }
}).on('close',()=>{record({ended:true});process.exit(0)});
`,
  );
  await chmod(bin, 0o700);
  return { codexBin: bin, cwd, resourceUrl: "https://builder.example/mcp", trace };
};
const readTrace = async (trace: string) => {
  const raw = await readFile(trace, "utf-8");
  return raw
    .trim()
    .split("\n")
    .map((line) =>
      z
        .looseObject({
          method: z.string().optional(),
          params: z.json().optional(),
          args: z.array(z.string()).optional(),
        })
        .parse(JSON.parse(line)),
    );
};

it("dispatches the five public tools through the native protocol without a model turn", async () => {
  const f = await fixture();
  const client = await connectHostedSession(f);
  try {
    expect(client.tools.map((tool) => tool.name)).toEqual(hostedSessionTools);
    expect(client.tools[0]?.description).toBe("upstream autograph_start");
    expect(client.tools[0]?._meta).toEqual({ fixture: true });
    for (const name of hostedSessionTools) {
      expect(
        await client.call(
          name,
          { sessionId: "retained-session", clientRequestId: "stable-request" },
          { trace: "opaque" },
        ),
      ).toEqual({
        _meta: { upstream: true },
        content: [{ text: "public result", type: "text" }],
        structuredContent: { cursor: 1955, sessionId: "retained-session" },
      });
    }
    await expect(client.call("private_tool", {})).rejects.toThrow("five public");
  } finally {
    await client.close();
  }
  const trace = await readTrace(f.trace);
  const methods = trace.flatMap((event) => (event.method === undefined ? [] : [event.method]));
  expect(methods.slice(0, 3)).toEqual(["initialize", "initialized", "thread/start"]);
  expect(methods.filter((method) => method === "mcpServerStatus/list")).toHaveLength(2);
  expect(methods.filter((method) => method === "mcpServer/tool/call")).toHaveLength(5);
  expect(methods).not.toContain("turn/start");
  expect(trace.find((event) => event.method === "thread/start")?.params).toMatchObject({
    ephemeral: true,
  });
  expect(trace.find((event) => event.method === "mcpServer/tool/call")?.params).toEqual({
    _meta: { trace: "opaque" },
    arguments: { clientRequestId: "stable-request", sessionId: "retained-session" },
    server: "a511-original",
    threadId: "ephemeral-native-thread",
    tool: "autograph_start",
  });
  expect(trace[0].args).toContain('plugins."app-builder@autograph-dev".enabled=false');
  expect(trace[0].args).toContain('plugins."app-builder@autograph".enabled=false');
  expect(trace[0].args).toContain(
    'mcp_servers.a511-original.oauth_resource="https://builder.example/mcp"',
  );
  expect(trace.at(-1)).toEqual({ ended: true });
  expect(await readdir(f.cwd)).toEqual([]);
});
it.each(["auth", "origin"])("fails closed and cleans the child for %s mismatch", async (mode) => {
  const f = await fixture(mode);
  await expect(connectHostedSession(f)).rejects.toThrow(
    mode === "auth" ? "codex mcp login a511-original" : "Native hosted Builder transport failed",
  );
  expect(await readdir(f.cwd)).toEqual([]);
  const trace = await readTrace(f.trace);
  expect(trace.some((event) => event.method === "mcpServer/tool/call")).toBe(false);
});
it("redacts native error detail and never retries a submitted tool", async () => {
  const f = await fixture("error");
  const client = await connectHostedSession(f);
  try {
    await expect(client.call("autograph_send", { clientRequestId: "stable" })).rejects.toThrow(
      "reconcile the existing request",
    );
  } finally {
    await client.close();
  }
  const trace = await readTrace(f.trace);
  expect(trace.filter((event) => event.method === "mcpServer/tool/call")).toHaveLength(1);
});
it.each([
  "http://builder.example/mcp",
  "https://user:secret@builder.example/mcp",
  "https://builder.example/mcp?secret=x",
  "https://builder.example/other",
])("rejects a noncanonical resource without starting a child: %s", async (resourceUrl) => {
  await expect(
    connectHostedSession({ codexBin: "/missing", cwd: "/private/tmp", resourceUrl }),
  ).rejects.toThrow("credential-free HTTPS /mcp");
});

it("cleans its native child when cancelled after connection", async () => {
  const f = await fixture();
  const cancellation = new AbortController();
  const client = await connectHostedSession({ ...f, signal: cancellation.signal });
  cancellation.abort();
  await client.close();
  await expect(client.call("autograph_get", {})).rejects.toThrow("reconcile the existing request");
});
it("cleans private state when the native executable cannot start", async () => {
  const f = await fixture();
  await expect(
    connectHostedSession({ ...f, codexBin: path.join(f.cwd, "missing") }),
  ).rejects.toThrow("reconcile the existing request");
  expect(await readdir(f.cwd)).toEqual([]);
});

it("cancels startup without leaving the native process or private checkout", async () => {
  const f = await fixture("stall");
  const cancellation = new AbortController();
  const pending = connectHostedSession({ ...f, signal: cancellation.signal });
  const rejected = expect(pending).rejects.toThrow("reconcile the existing request");
  await vi.waitFor(async () => {
    const trace = await readTrace(f.trace);
    expect(trace.some((event) => event.method === "initialize")).toBe(true);
  });
  cancellation.abort();
  await rejected;
  expect(await readdir(f.cwd)).toEqual([]);
  const trace = await readTrace(f.trace);
  expect(trace.at(-1)).toMatchObject({ ended: true });
});
