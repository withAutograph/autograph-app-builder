/* oxlint-disable promise/avoid-new -- Private Node socket events require owned event-to-Promise adapters. */
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { verifyManagedCapability } from "./managed-runtime-capabilities";
import {
  managedLifecycleCommandSchema,
  managedLifecycleReceiptSchema,
} from "./managed-runtime-supervisor";
import type {
  ManagedLifecycleCommand,
  ManagedLifecycleReceipt,
  createManagedRuntimeSupervisor,
} from "./managed-runtime-supervisor";

const unavailable = () => new Error("Managed lifecycle is unavailable.");
const frameSchema = z.strictObject({
  capability: z.string(),
  command: managedLifecycleCommandSchema,
});
const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), receipt: managedLifecycleReceiptSchema }),
  z.strictObject({ ok: z.literal(false) }),
]);
// One metadata frame, not a workload quota. No app files/rows/commands are accepted here.
const frameLimit = 4096;
export const startManagedRuntimeIpc = async (input: {
  lifecycleSha256: string;
  supervisor: ReturnType<typeof createManagedRuntimeSupervisor>;
  rootDirectory?: string;
}) => {
  const directory = await mkdtemp(path.join(input.rootDirectory ?? tmpdir(), "amr-"));
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, "c.sock");
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => {
      connections.delete(socket);
    });
    const timer = setTimeout(() => {
      socket.destroy();
    }, 30_000);
    socket.once("close", () => {
      clearTimeout(timer);
    });
    let buffer = Buffer.alloc(0);
    let processing = false;
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("data", (data) => {
      const chunk = Buffer.from(z.instanceof(Uint8Array).parse(data));
      if (processing) {
        return;
      }
      if (buffer.length + chunk.length > frameLimit) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (!buffer.includes(10)) {
        return;
      }
      processing = true;
      void (async () => {
        try {
          const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
          const frame = frameSchema.parse(raw);
          if (!verifyManagedCapability(frame.capability, input.lifecycleSha256)) {
            throw unavailable();
          }
          const receipt = await input.supervisor.execute(frame.command);
          socket.end(`${JSON.stringify({ ok: true, receipt })}\n`);
        } catch {
          socket.end('{"ok":false}\n');
        }
      })();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
  } catch {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw unavailable();
  }
  return {
    socketPath,
    async close() {
      for (const socket of connections) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
};

/** Private suite capability and path stay in this closure, never app environment or Gateway headers. Retry the same commandId after uncertain I/O. */
export const createManagedRuntimeIpcClient = (input: {
  socketPath: string;
  lifecycleCapability: string;
}) => ({
  async execute(command: ManagedLifecycleCommand): Promise<ManagedLifecycleReceipt> {
    const payload = `${JSON.stringify({ capability: input.lifecycleCapability, command: managedLifecycleCommandSchema.parse(command) })}\n`;
    if (Buffer.byteLength(payload) > frameLimit) {
      throw unavailable();
    }
    return await new Promise<ManagedLifecycleReceipt>((resolve, reject) => {
      const socket = createConnection(input.socketPath);
      let buffer = Buffer.alloc(0);
      let settled = false;
      const fail = () => {
        if (!settled) {
          settled = true;
          reject(unavailable());
        }
        socket.destroy();
      };
      const timer = setTimeout(fail, 30_000);
      socket.once("close", () => {
        clearTimeout(timer);
        if (!settled) {
          fail();
        }
      });
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.write(payload);
      });
      socket.on("data", (data) => {
        const chunk = Buffer.from(z.instanceof(Uint8Array).parse(data));
        if (settled) {
          return;
        }
        if (buffer.length + chunk.length > frameLimit) {
          fail();
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        if (!buffer.includes(10)) {
          return;
        }
        try {
          const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
          const response = responseSchema.parse(raw);
          if (!response.ok) {
            fail();
            return;
          }
          settled = true;
          resolve(response.receipt);
          socket.end();
        } catch {
          fail();
        }
      });
    });
  },
});
