import { createHash, randomBytes } from "node:crypto";

export interface WorkingPreviewAccess {
  /** Validated runtime configuration; contains a launch digest, never the bearer capability. */
  configuration: string;
  /** Bearer capability. Deliver only through the owning user's authenticated session. */
  launchUrl: string;
  expiresAt: number;
  source: string;
}

/**
 * The preview uses its own origin: explicit Authorization belongs to the application.
 * Never inject Builder credentials into requests to this gateway. Arbitrary bearer
 * values cannot be classified as application or Builder credentials here.
 * This is not an isolation boundary against code sharing the gateway OS user.
 */
export const createWorkingPreviewAccess = (input: {
  /** Coordinator-owned file. Missing or invalid content keeps an already-bound gateway closed. */
  configurationPath?: string;
  origin: string;
  appPort: number;
  gatewayPort: number;
  landingPath?: string;
  expiresAt: number;
}): WorkingPreviewAccess => {
  const origin = new URL(input.origin);
  if (origin.protocol !== "https:" || origin.origin !== input.origin) {
    throw new Error("Working preview access requires an exact HTTPS origin.");
  }
  for (const port of [input.appPort, input.gatewayPort]) {
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
      throw new Error("Working preview ports must be valid unprivileged ports.");
    }
  }
  if (input.appPort === input.gatewayPort || !Number.isSafeInteger(input.expiresAt)) {
    throw new Error("Working preview requires separate ports and an expiry timestamp.");
  }
  const landingPath = input.landingPath ?? "/";
  const landing = new URL(landingPath, origin);
  if (
    !landingPath.startsWith("/") ||
    landing.origin !== origin.origin ||
    landing.pathname === "/__autograph_preview_launch"
  ) {
    throw new Error("Working preview landing path must stay on the preview origin.");
  }
  const credential = randomBytes(32).toString("base64url");
  const config = JSON.stringify({
    ...input,
    host: origin.host,
    landingPath: landing.pathname + landing.search + landing.hash,
    launchDigest: createHash("sha256").update(credential).digest("hex"),
  });
  return {
    configuration: config,
    expiresAt: input.expiresAt,
    launchUrl: `${origin.origin}/__autograph_preview_launch?token=${credential}`,
    source: `import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
const bootstrap = ${config};
const loadConfiguration = () => {
  if (bootstrap.configurationPath === undefined) return bootstrap;
  try {
    const active = JSON.parse(readFileSync(bootstrap.configurationPath, "utf8"));
    const origin = new URL(active.origin);
    const landing = new URL(active.landingPath, origin);
    if (origin.protocol !== "https:" || origin.origin !== active.origin || origin.host !== active.host ||
        typeof active.landingPath !== "string" || !active.landingPath.startsWith("/") || landing.origin !== origin.origin ||
        landing.pathname === "/__autograph_preview_launch" || !Number.isSafeInteger(active.expiresAt) ||
        active.appPort !== bootstrap.appPort || active.gatewayPort !== bootstrap.gatewayPort ||
        typeof active.launchDigest !== "string" || !/^[a-f0-9]{64}$/.test(active.launchDigest)) return null;
    return active;
  } catch { return null; }
};
const cookieName = "__Host-autograph-preview";
const session = randomBytes(32).toString("base64url");
const digest = value => createHash("sha256").update(value).digest();
const equal = (value, expected) => timingSafeEqual(digest(value), digest(expected));
const hop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const cleanHeaders = headers => {
  const excluded = new Set([...hop, ...(headers.connection ?? "").toLowerCase().split(",").map(value => value.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
};
const forwardedHeaders = (request, config, cookies) => {
  const headers = cleanHeaders(request.headers);
  delete headers["x-vercel-oidc-token"];
  delete headers["x-vercel-protection-bypass"];
  delete headers["x-vercel-set-bypass-cookie"];
  delete headers.referer;
  delete headers["forwarded"];
  for (const name of Object.keys(headers)) if (name.startsWith("x-forwarded-")) delete headers[name];
  headers.cookie = cookies.filter(value => !value.startsWith(cookieName + "=")).join("; ");
  headers.host = config.host;
  headers["x-forwarded-host"] = config.host;
  headers["x-forwarded-proto"] = "https";
  return headers;
};
const deny = (response, status = 403) => { response.writeHead(status, { "cache-control": "private, no-store", "referrer-policy": "no-referrer" }); response.end(); };
const server = http.createServer((request, response) => {
  const config = loadConfiguration();
  if (config === null) return deny(response);
  const accessCookie = digest(session + config.launchDigest).toString("base64url");
  if (request.headers.host !== config.host || Date.now() >= config.expiresAt) return deny(response);
  let url;
  try { url = new URL(request.url, config.origin); } catch { return deny(response, 400); }
  if (url.origin !== config.origin) return deny(response);
  if (url.pathname === "/__autograph_preview_launch") {
    const token = url.searchParams.get("token") ?? "";
    if (request.method !== "GET" || url.searchParams.getAll("token").length !== 1 || !timingSafeEqual(digest(token), Buffer.from(config.launchDigest, "hex"))) return deny(response);
    response.writeHead(303, {
      location: config.landingPath,
      "set-cookie": cookieName + "=" + accessCookie + "; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=" + new Date(config.expiresAt).toUTCString(),
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    });
    response.end(); return;
  }
  const cookies = (request.headers.cookie ?? "").split(";").map(value => value.trim());
  const access = cookies.filter(value => value.startsWith(cookieName + "="));
  if (access.length !== 1 || !equal(access[0].slice(cookieName.length + 1), accessCookie)) return deny(response);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin !== config.origin) return deny(response);
  const headers = forwardedHeaders(request, config, cookies);
  const upstream = http.request({ hostname: "127.0.0.1", port: config.appPort, path: url.pathname + url.search, method: request.method, headers }, result => {
    const outgoing = cleanHeaders(result.headers);
    outgoing["cache-control"] = "private, no-store";
    outgoing["referrer-policy"] = "no-referrer";
    if (outgoing["set-cookie"]) outgoing["set-cookie"] = outgoing["set-cookie"].filter(value => !value.trim().startsWith(cookieName + "="));
    response.writeHead(result.statusCode ?? 502, outgoing);
    result.pipe(response);
  });
  upstream.on("error", () => { if (!response.headersSent) deny(response, 502); else response.destroy(); });
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => upstream.destroy());
  request.pipe(upstream);
});
const upgradedConnections = new Set();
const closeUpgrades = () => { for (const close of upgradedConnections) close(); };
// Node's server.close does not close upgraded sockets on its own.
const closeHttpServer = server.close.bind(server);
server.close = (...args) => { closeUpgrades(); return closeHttpServer(...args); };
server.on("upgrade", (request, socket, head) => {
  socket.on("error", () => socket.destroy());
  const reject = (status = 403) => socket.end("HTTP/1.1 " + status + " Rejected\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n");
  const config = loadConfiguration();
  if (config === null || request.method !== "GET" || request.headers.host !== config.host || request.headers.origin !== config.origin || Date.now() >= config.expiresAt || request.headers.upgrade?.toLowerCase() !== "websocket") return reject();
  let url;
  try { url = new URL(request.url, config.origin); } catch { return reject(400); }
  if (url.origin !== config.origin || url.pathname === "/__autograph_preview_launch") return reject();
  const cookies = (request.headers.cookie ?? "").split(";").map(value => value.trim());
  const access = cookies.filter(value => value.startsWith(cookieName + "="));
  const accessCookie = digest(session + config.launchDigest).toString("base64url");
  if (access.length !== 1 || !equal(access[0].slice(cookieName.length + 1), accessCookie)) return reject();
  const headers = forwardedHeaders(request, config, cookies);
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";
  socket.pause();
  let peer;
  let closed = false;
  const upstream = http.request({ hostname: "127.0.0.1", port: config.appPort, path: url.pathname + url.search, method: "GET", headers });
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(expiry);
    upgradedConnections.delete(close);
    upstream.destroy();
    peer?.destroy();
    socket.destroy();
  };
  const expiry = setTimeout(close, Math.max(0, config.expiresAt - Date.now()));
  upgradedConnections.add(close);
  upstream.on("upgrade", (result, upstreamSocket, upstreamHead) => {
    peer = upstreamSocket;
    if (closed) return upstreamSocket.destroy();
    if (Date.now() >= config.expiresAt || result.statusCode !== 101 || result.headers.upgrade?.toLowerCase() !== "websocket") return close();
    const outgoing = cleanHeaders(result.headers);
    outgoing.connection = "Upgrade";
    outgoing.upgrade = "websocket";
    if (outgoing["set-cookie"]) outgoing["set-cookie"] = outgoing["set-cookie"].filter(value => !value.trim().startsWith(cookieName + "="));
    socket.write("HTTP/1.1 101 Switching Protocols\\r\\n" + Object.entries(outgoing).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => name + ": " + item + "\\r\\n")).join("") + "\\r\\n");
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) peer.write(head);
    peer.on("error", close);
    peer.on("close", close);
    socket.pipe(peer);
    peer.pipe(socket);
    socket.resume();
  });
  upstream.on("response", (response) => { response.resume(); close(); });
  upstream.on("error", close);
  socket.on("error", close);
  socket.on("close", close);
  upstream.end();
});
server.on("connect", (_request, socket) => socket.destroy());
server.listen(bootstrap.gatewayPort, "0.0.0.0");
`,
  };
};
