import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createProtectedHostedOperatorHandler } from "../lib/provisioning/hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "../lib/provisioning/hosted-operator-service";

// Separate trusted deployment. Adapter paths never come from an HTTP request or generated app.
const [adapterPath, expectedSha256, portInput = "8789"] = process.argv.slice(2);
if (
  !adapterPath ||
  !path.isAbsolute(adapterPath) ||
  !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? "")
) {
  throw new Error(
    "protected_operator_required: supply an absolute reviewed adapter module and its sha256",
  );
}
const bytes = await readFile(adapterPath);
if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
  throw new Error("protected_operator_required: adapter digest mismatch");
}
const adapterSchema = z.object({
  createDependencies: z.custom<() => Promise<ProtectedHostedOperatorDependencies>>(
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reviewed code exports a factory; the handler validates every mandatory returned callback at startup.
    (value) => typeof value === "function",
  ),
});
const adapter = adapterSchema.parse(await import(pathToFileURL(adapterPath).href));
const handler = createProtectedHostedOperatorHandler(await adapter.createDependencies());
const port = z.coerce.number().int().min(1024).max(65_535).parse(portInput);
createServer((incoming, outgoing) => {
  const respond = async () => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) {
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
      }
    }
    const request = new Request(`http://127.0.0.1:${port}${incoming.url ?? "/"}`, {
      body: incoming.method === "POST" ? await text(incoming) : undefined,
      headers,
      method: incoming.method,
    });
    const response = await handler(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  };
  void (async () => {
    try {
      await respond();
    } catch {
      outgoing.writeHead(500, { "cache-control": "no-store" });
      outgoing.end('{"code":"operator_unavailable"}');
    }
  })();
}).listen(port, "127.0.0.1");
