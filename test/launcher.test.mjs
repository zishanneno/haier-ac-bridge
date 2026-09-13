import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const windows = process.platform === "win32";

async function unusedPort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

function launch(root) {
  const env = { ...process.env, CI: "true" };
  for (const key of Object.keys(env)) {
    if (/^(PORT|HOST|DATA_DIR|NODE_ENV|NODE_OPTIONS)$|^HAIER_|^HAISMART_/i.test(key))
      delete env[key];
  }
  // A fresh install must use the bundled SQLite binary, without invoking node-gyp.
  env.NODE_GYP_FORCE_PYTHON = join(root, "python-must-not-be-required");
  env.npm_config_side_effects_cache = "false";
  const [command, args] = windows
    ? [
        process.env.ComSpec || "cmd.exe",
        ["/d", "/s", "/c", 'call "' + join(root, "Start-windows.cmd") + '"'],
      ]
    : process.platform === "darwin"
      ? [join(root, "Start-mac.command"), []]
      : [process.execPath, [join(root, "scripts/launch.mjs")]];
  const child = spawn(command, args, {
    cwd: dirname(root), // The launcher must find its source when invoked from elsewhere.
    env,
    detached: !windows,
    windowsVerbatimArguments: windows,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const run = { child, output: "", ended: false, error: null };
  child.stdout.on("data", (chunk) => (run.output += chunk));
  child.stderr.on("data", (chunk) => (run.output += chunk));
  child.once("error", (error) => (run.error = error));
  child.once("close", () => (run.ended = true));
  return run;
}

async function waitFor(predicate, milliseconds, message) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(message);
}

async function stop(run, force = false) {
  if (!run.child.pid) return;
  if (windows) {
    // Node cannot send a console Ctrl+C on Windows. Terminate the complete tree
    // and check that the server is gone; interactive Ctrl+C remains a manual check.
    if (!run.ended) {
      const result = spawnSync("taskkill.exe", ["/pid", String(run.child.pid), "/T", "/F"], {
        encoding: "utf8",
        timeout: 15000,
      });
      if (!force) assert.equal(result.status, 0, "Could not stop the Windows launcher tree");
    }
  } else {
    try {
      process.kill(-run.child.pid, force ? "SIGKILL" : "SIGINT");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  await waitFor(() => run.ended, 15000, "Launcher did not exit after shutdown");
  if (!windows && !force) {
    assert.ok(
      run.child.exitCode === 0 || run.child.exitCode === 130 || run.child.signalCode === "SIGINT",
      "Launcher failed during Ctrl+C shutdown",
    );
  }
}

test(
  "fresh launcher installs, starts on a custom port, stops, and preserves setup on restart",
  { timeout: 300000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "haier launcher "));
    let run;
    try {
      for (const name of [
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        "openapi.yaml",
        "src",
        "web",
        "scripts/launch.mjs",
        "Start-mac.command",
        "Start-windows.cmd",
      ]) {
        cpSync(join(source, name), join(root, name), { recursive: true });
      }
      const port = await unusedPort();
      const url = "http://127.0.0.1:" + port;
      writeFileSync(
        join(root, ".env"),
        "PORT=" + port + "\nHOST=127.0.0.1\nHAIER_OPEN_BROWSER=0\n",
      );
      assert.ok(!existsSync(join(root, "node_modules")));
      assert.ok(!existsSync(join(root, "dist")));
      assert.ok(!existsSync(join(root, "data")));
      let credentials;
      for (const phase of ["first install", "restart"]) {
        run = launch(root);
        await waitFor(
          () => {
            if (run.error) throw run.error;
            assert.ok(!run.ended, "Launcher exited before it was ready");
            return run.output.includes("Open " + url + " and enter the Bridge access code above.");
          },
          120000,
          "Launcher did not become ready",
        );
        assert.ok(
          /Bridge access code: [a-f0-9]{4}(?:-[a-f0-9]{4}){3}/i.test(run.output),
          "Missing access code",
        );
        assert.ok(run.output.indexOf("Bridge access code:") < run.output.indexOf("Open " + url));
        for (const path of ["/health", "/"]) {
          const response = await fetch(url + path, { signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 200, phase + " did not serve " + path);
          await response.arrayBuffer();
        }
        assert.ok(existsSync(join(root, "node_modules")));
        assert.ok(!existsSync(join(root, "dist")), "Launcher should not require compiled output");
        const saved = readFileSync(join(root, "data/access.json"), "utf8");
        if (credentials) assert.ok(saved === credentials, "Restart changed the saved credentials");
        credentials = saved;
        await stop(run);
        assert.equal(
          await portIsOpen(port),
          false,
          "Server still accepts connections after shutdown",
        );
        t.diagnostic(
          phase + ": app ready, access code printed, custom port honored, process stopped",
        );
        run = null;
      }
    } catch (error) {
      // Never expose generated access credentials in public CI output.
      if (run)
        t.diagnostic(
          run.output
            .replace(/Bridge access code:[^\r\n]*/g, "Bridge access code: [redacted]")
            .slice(-6000),
        );
      throw error;
    } finally {
      try {
        if (run) await stop(run, true);
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  },
);
