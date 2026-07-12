import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSnapshot } from "./lib/snapshot.mjs";
import { jsonSafe, sanitize } from "./lib/sanitize.mjs";
import { log } from "./lib/logger.mjs";

const HOST = "127.0.0.1";
const PORT = 9127;
const MAX_URL_BYTES = 2048;
const MAX_HEADER_COUNT = 50;
const EXPECTED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`, "mac-mini-de-edoardo.tailb4415f.ts.net"]);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");

function headers(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extra
  };
}

function send(req, res, status, body, type = "text/plain; charset=utf-8") {
  const payload = req.method === "HEAD" ? "" : body;
  res.writeHead(status, headers({
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(payload)
  }));
  res.end(payload);
}

function validRequest(req) {
  if (!["GET", "HEAD"].includes(req.method)) return [false, 405, "method not allowed"];
  if ((req.url || "").length > MAX_URL_BYTES) return [false, 414, "uri too long"];
  if (req.rawHeaders.length / 2 > MAX_HEADER_COUNT) return [false, 431, "too many headers"];
  const host = req.headers.host || "";
  if (!EXPECTED_HOSTS.has(host)) return [false, 400, "invalid host"];
  const origin = req.headers.origin;
  if (origin && origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`) {
    return [false, 403, "origin denied"];
  }
  return [true, 200, "ok"];
}

async function staticFile(name, req, res) {
  const filePath = path.join(PUBLIC, name);
  if (!filePath.startsWith(`${PUBLIC}/`)) return send(req, res, 404, "not found");
  const ext = path.extname(filePath);
  const type = ext === ".css" ? "text/css; charset=utf-8" : ext === ".js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
  try {
    const body = await fs.readFile(filePath);
    send(req, res, 200, body, type);
  } catch {
    send(req, res, 404, "not found");
  }
}

export function createServer() {
  const server = http.createServer(async (req, res) => {
    req.socket.setTimeout(3000);
    const [ok, status, reason] = validRequest(req);
    if (!ok) {
      await log("warn", "request rejected", { status, reason, method: req.method, url: req.url, host: req.headers.host });
      return send(req, res, status, reason);
    }
    try {
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      if (url.pathname === "/api/snapshot") {
        const simulateBrokenSource = url.searchParams.get("simulateBrokenSource") === "1";
        const snapshot = await getSnapshot({ simulateBrokenSource });
        const body = jsonSafe(snapshot);
        return send(req, res, 200, body, "application/json; charset=utf-8");
      }
      if (url.pathname === "/" || url.pathname === "/index.html") return staticFile("index.html", req, res);
      if (url.pathname === "/styles.css") return staticFile("styles.css", req, res);
      if (url.pathname === "/app.js") return staticFile("app.js", req, res);
      return send(req, res, 404, "not found");
    } catch (err) {
      await log("error", "request failed", { name: err?.name, code: err?.code });
      return send(req, res, 500, JSON.stringify(sanitize({ error: "internal error" })), "application/json; charset=utf-8");
    }
  });
  server.headersTimeout = 4000;
  server.requestTimeout = 4000;
  server.keepAliveTimeout = 1000;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(PORT, HOST, async () => {
    await log("info", "server started", { host: HOST, port: PORT });
    console.log(`orchestration-dashboard listening on http://${HOST}:${PORT}`);
  });
}
