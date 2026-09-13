import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);

// Windows installs pnpm as a .cmd shim, which needs cmd.exe to execute it.
function pnpm(args, stdio) {
  return process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "pnpm " + args.join(" ")], {
        stdio,
        encoding: "utf8",
      })
    : spawnSync("pnpm", args, { stdio, encoding: "utf8" });
}

function openBrowser(server) {
  const address = server.address();
  if (!address || typeof address === "string") return;
  let host = address.address;
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  if (host.includes(":")) host = "[" + host + "]";
  // The bound socket supplies a numeric IP and port, never shell input from .env.
  const url = "http://" + host + ":" + address.port;
  console.log("Open " + url + " and enter the Bridge access code above.");
  if (process.env.HAIER_OPEN_BROWSER === "0") return;
  const [command, args] =
    process.platform === "win32"
      ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", 'start "" "' + url + '"']]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const browser = spawn(command, args, { stdio: "ignore" });
  const fallback = () =>
    console.log("Could not open your browser automatically. Open " + url + " manually.");
  browser.once("error", fallback);
  browser.once("exit", (code) => {
    if (code !== null && code !== 0) fallback();
  });
  browser.unref();
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error(
      "Node.js 22 or newer is required. Install Node.js 22 or 24 from https://nodejs.org.",
    );
  }
  const { packageManager } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const requiredVersion = packageManager.split("@")[1];
  const version = pnpm(["--version"], "pipe");
  if (version.error || version.status !== 0 || version.stdout.trim() !== requiredVersion) {
    throw new Error(
      "Install pnpm " +
        requiredVersion +
        " in a terminal, then reopen this launcher:\n\n  npm install --global pnpm@" +
        requiredVersion,
    );
  }
  console.log("Checking dependencies. The first start may take a few minutes...");
  const install = pnpm(["install", "--frozen-lockfile", "--prod=false"], "inherit");
  if (install.signal === "SIGINT") {
    process.exitCode = 130;
    return;
  }
  if (install.error || install.status !== 0) {
    throw new Error(
      "Dependency installation failed. Check the output above and your Internet connection, then try again.",
    );
  }
  console.log("Starting Haier AC Bridge. Keep this window open; press Ctrl+C to stop.");
  const { register } = await import("tsx/esm/api");
  register();
  const { server } = await import("../src/server.ts");
  if (server.listening) openBrowser(server);
  else server.once("listening", () => openBrowser(server));
}

main().catch((error) => {
  console.error("\n" + error.message);
  process.exitCode = 1;
});
