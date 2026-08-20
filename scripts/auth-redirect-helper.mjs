import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);

function argValue(name, fallback = "") {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

const port = Number.parseInt(argValue("--port", "3000"), 10);
const targetFile = argValue("--target-file", "");
const fallbackTarget = argValue("--target", "http://localhost:3014");

function readTargetOrigin() {
  if (!targetFile) return fallbackTarget;
  try {
    const parsed = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    if (
      typeof parsed.targetOrigin === "string" &&
      /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(parsed.targetOrigin)
    ) {
      return parsed.targetOrigin;
    }
  } catch {
    // Fall through to the safe local fallback.
  }
  return fallbackTarget;
}

function renderRedirectPage(targetOrigin) {
  const targetJson = JSON.stringify(targetOrigin);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CFS sign-in redirect</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: "Segoe UI", sans-serif; background: #eef6f7; color: #253342; }
    main { width: min(440px, calc(100vw - 32px)); padding: 24px; border: 1px solid #c8e4e6; border-radius: 14px; background: #fff; box-shadow: 0 18px 45px rgba(20, 60, 70, .12); }
    h1 { margin: 0 0 8px; font-size: 18px; }
    p { margin: 0; color: #667085; line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <h1>Returning to CFS</h1>
    <p>Passing the Microsoft sign-in result back to the running CFS app.</p>
  </main>
  <script>
    const target = new URL(${targetJson});
    target.pathname = "/";
    target.search = window.location.search;
    target.hash = window.location.hash;
    window.location.replace(target.toString());
  </script>
</body>
</html>`;
}

function startServer(host) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      if (request.url === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      const targetOrigin = readTargetOrigin();
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      response.end(renderRedirectPage(targetOrigin));
    });
    server.on("error", (error) => {
      console.log(`[auth-redirect-helper] ${host}:${port} not started: ${error.code || error.message}`);
      resolve(null);
    });
    server.listen(port, host, () => {
      console.log(`[auth-redirect-helper] listening on ${host}:${port}`);
      resolve(server);
    });
  });
}

if (!Number.isFinite(port) || port < 1 || port > 65535) {
  console.error(`[auth-redirect-helper] invalid port: ${argValue("--port", "")}`);
  process.exit(0);
}

const servers = (await Promise.all([startServer("127.0.0.1"), startServer("::1")])).filter(Boolean);
if (servers.length === 0) {
  process.exit(0);
}
