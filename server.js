const fs = require("fs");
const path = require("path");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

// Target app. You can override it with the TARGET_URL environment variable.
const TARGET =
  process.env.TARGET_URL ||
  "https://aaaamd-pair-6c2b0a32a46f.herokuapp.com/";

// Statuses that mean "the target is down" (crashed, sleeping, timed out...).
const DOWN_STATUS = new Set([502, 503, 504]);

// Load the maintenance page once at startup.
let MAINTENANCE_PAGE;
try {
  MAINTENANCE_PAGE = fs.readFileSync(path.join(__dirname, "404.html"));
} catch {
  MAINTENANCE_PAGE = Buffer.from(
    "<!DOCTYPE html><title>CIPHER MINI</title><h1>CIPHER MINI is under maintenance</h1>"
  );
}

function sendMaintenance(res) {
  // WebSocket errors give us a raw socket instead of a normal response.
  if (!res || typeof res.writeHead !== "function") {
    if (res && typeof res.destroy === "function") res.destroy();
    return;
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(503, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": MAINTENANCE_PAGE.length,
    "Cache-Control": "no-store",
    "Retry-After": "30",
    "X-Robots-Tag": "noindex",
  });
  res.end(MAINTENANCE_PAGE);
}

// Heroku's own "no such app" page (app deleted or renamed).
function isNoSuchApp(body) {
  return /no such app/i.test(body.toString("utf8", 0, 20000));
}

function targetIsValid(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

if (!TARGET || !targetIsValid(TARGET)) {
  // No usable target URL: show the maintenance page for everything.
  console.warn("TARGET URL is missing or invalid. Serving maintenance page.");
  app.use((req, res) => sendMaintenance(res));
} else {
  const targetHost = new URL(TARGET).host;

  app.use(
    "/",
    createProxyMiddleware({
      target: TARGET,
      changeOrigin: true,
      secure: true,
      proxyTimeout: 30000,
      selfHandleResponse: true,

      on: {
        proxyReq: (proxyReq) => {
          proxyReq.setHeader("Host", targetHost);
        },

        proxyRes: (proxyRes, req, res) => {
          const status = proxyRes.statusCode;

          // Target is down -> maintenance page
          if (DOWN_STATUS.has(status)) {
            proxyRes.resume();
            return sendMaintenance(res);
          }

          // 404: only replace it when it is Heroku's "no such app" page.
          // Normal 404s from the real app pass through untouched.
          if (status === 404) {
            const chunks = [];
            proxyRes.on("data", (c) => chunks.push(c));
            proxyRes.on("end", () => {
              const body = Buffer.concat(chunks);
              if (isNoSuchApp(body)) return sendMaintenance(res);
              res.writeHead(status, proxyRes.statusMessage, proxyRes.headers);
              res.end(body);
            });
            return;
          }

          // Everything else is streamed straight through.
          res.writeHead(status, proxyRes.statusMessage, proxyRes.headers);
          proxyRes.pipe(res);
        },

        // Target unreachable (DNS error, refused connection, timeout...)
        error: (err, req, res) => {
          console.error("Proxy error:", err.code || err.message);
          sendMaintenance(res);
        },
      },
    })
  );
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
