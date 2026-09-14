/* oxlint-disable promise/avoid-new -- Bridge browser and Node event callbacks in a real transport fixture. */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { observePreviewWebSockets } from "./self-reproduction-preview-websockets";

it("retains actual browser socket lifecycle without private URLs or frames", async () => {
  const server = createServer((_request, response) => {
    response.end("observer fixture");
  });
  server.on("upgrade", (request, socket) => {
    if (request.url?.startsWith("/denied") === true) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (key === undefined || key === "") {
      socket.destroy();
      return;
    }
    // oxlint-disable-next-line sonarjs/hashing -- SHA-1 is required by the WebSocket handshake protocol.
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // A normal 1000 close frame; the observer deliberately makes no close-code claim.
    socket.on("data", () => {
      socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
    });
    socket.on("end", () => {
      socket.destroy();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node address API returns a pipe string or TCP address.
  if (address === null || typeof address === "string") {
    throw new Error("Fixture address unavailable");
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const events = observePreviewWebSockets(page);
    expect(events).toEqual([]);
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.evaluate(async (port) => {
      await new Promise<void>((resolve) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${port}/private-secret-path?token=private-token`,
        );
        socket.addEventListener("open", () => {
          socket.close();
        });
        socket.addEventListener("close", () => {
          resolve();
        });
      });
    }, address.port);
    await expect.poll(() => events.map(({ event }) => event)).toEqual(["created", "closed"]);
    await page.evaluate(async (port) => {
      await new Promise<void>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/denied?secret=hidden`);
        socket.addEventListener("close", () => {
          resolve();
        });
      });
    }, address.port);
    await expect
      .poll(() => events.map(({ event }) => event))
      .toEqual(["created", "closed", "created", "error", "closed"]);
    expect(events.every(({ url }) => url.endsWith("/[REDACTED URL]"))).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/private-secret-path|private-token|hidden|1000/u);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}, 30_000);
