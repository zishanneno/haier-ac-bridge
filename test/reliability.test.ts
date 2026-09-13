import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer, type Socket } from "node:net";
import { createCipheriv, createHash } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import { BridgeDatabase } from "../src/database.js";
import { HaierKeyRefresher } from "../src/haier-cloud.js";
import { controlDevice, readDeviceStatus } from "../src/protocol.js";

const savedSession = {
  clientId: "test",
  accessToken: "old",
  refreshToken: "renewable",
  zoneInfo: "92",
};
function database(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "haier-reliability-"));
  const db = new BridgeDatabase(join(dir, "bridge.sqlite"));
  db.saveSession(savedSession);
  db.saveDevice({ id: "room", name: "Room", host: "192.168.0.255", deviceId: "SYNTHETIC" });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}
const tokenResponse = () =>
  new Response(
    JSON.stringify({
      retCode: "00000",
      data: { tokenInfo: { accessToken: "new", refreshToken: "renewable" } },
    }),
  );

class Gateway extends EventEmitter {
  ended = false;
  end() {
    this.ended = true;
    // Real transports may emit close/error while being torn down.
    queueMicrotask(() => {
      this.emit("close");
      this.emit("error", new Error("late transport error"));
    });
    return this;
  }
  subscribe(_topic: string, _options: unknown, callback: (error?: Error) => void) {
    callback();
  }
  publish(_topic: string, payload: string) {
    const serial = JSON.parse(Buffer.from(JSON.parse(payload).data, "base64").toString()).sn;
    const data = Buffer.from(
      JSON.stringify({ sn: serial, key: "a".repeat(32), vers: 2, errNo: 0 }),
    ).toString("base64");
    queueMicrotask(() =>
      this.emit("message", "reply", Buffer.from(JSON.stringify({ type: "devLocalkey", data }))),
    );
  }
}

for (const failure of ["close", "error", "timeout"] as const) {
  test("gateway " + failure + " releases the cloud queue and permits recovery", async (t) => {
    const db = database(t);
    t.mock.method(globalThis, "fetch", async () => tokenResponse());
    if (failure === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
    let started!: () => void;
    const connecting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const clients: Gateway[] = [];
    const connector = (() => {
      const client = new Gateway();
      clients.push(client);
      queueMicrotask(() => {
        if (clients.length > 1) client.emit("connect");
        else if (failure === "close") client.emit("close");
        else if (failure === "error") client.emit("error", new Error("gateway unavailable"));
        started();
      });
      return client as unknown as MqttClient;
    }) as typeof mqtt.connect;
    const cloud = new HaierKeyRefresher(db, null, connector);
    const rejected = assert.rejects(
      cloud.refreshDeviceKey("SYNTHETIC"),
      /closed before connecting|connection timed out|gateway unavailable/,
    );
    // Queue another operation before the failed attempt settles.
    const retry = cloud.refreshDeviceKey("SYNTHETIC");
    await connecting;
    if (failure === "timeout") t.mock.timers.tick(8000);
    await rejected;
    await retry;
    assert.equal(db.device("room").localKeyVersion, 2);
    assert.ok(clients.every((client) => client.ended));
    await cloud.signOut();
    assert.equal(db.session(), null);
  });
}

for (const scenario of ["network", "timeout", "503", "429", "malformed", "vendor-code"] as const) {
  test("session refresh preserves credentials after " + scenario, async (t) => {
    const db = database(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (scenario === "network") throw new TypeError("fetch failed");
      if (scenario === "timeout") throw new DOMException("deadline", "TimeoutError");
      if (scenario === "malformed") return new Response("invalid JSON");
      if (scenario === "vendor-code") return new Response(JSON.stringify({ retCode: "UNKNOWN" }));
      return new Response("Service unavailable", { status: Number(scenario) });
    });
    const cloud = new HaierKeyRefresher(db, {
      username: "test@example.com",
      password: "test",
      zoneInfo: "92",
    });
    const expected = {
      network: /Could not reach Haier/,
      timeout: /timed out/,
      "503": /HTTP 503/,
      "429": /HTTP 429/,
      malformed: /non-JSON/,
      "vendor-code": /rejected the request \(UNKNOWN\)/,
    }[scenario];
    await assert.rejects(cloud.listDevices(), expected);
    assert.equal(calls, 1, "Transient errors must not trigger a password login");
    assert.deepEqual(db.session(), savedSession);
  });
}

test("explicit authentication rejection requests sign-in and permits configured login fallback", async (t) => {
  const db = database(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1 || calls === 2) return new Response("Unauthorized", { status: 401 });
    if (calls === 3) return tokenResponse();
    return new Response(JSON.stringify({ retCode: "00000", data: { deviceInfos: [] } }));
  });
  await assert.rejects(
    new HaierKeyRefresher(db, null).listDevices(),
    /rejected the saved session.*sign in/,
  );
  assert.deepEqual(db.session(), savedSession);
  const cloud = new HaierKeyRefresher(db, {
    username: "test@example.com",
    password: "test",
    zoneInfo: "92",
  });
  assert.deepEqual(await cloud.listDevices(), []);
  assert.equal(db.session()?.accessToken, "new");
  assert.equal(calls, 4);
});

// A synthetic uSS peer supplies wire frames over a real loopback socket. These
// fixtures test complete replies vs EOF/truncation without using any real AC.
const key = "0123456789abcdef0123456789abcdef";
const device = {
  id: "test",
  name: "Test",
  host: "127.0.0.1",
  deviceId: "SYNTHETIC",
  localKey: key,
  localKeyVersion: 1,
};
function frame(type: number, payload: Buffer, flag = 0) {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(0xea60 + type, 0);
  head.writeUInt16BE(payload.length + 10, 4);
  head[6] = 1;
  head[7] = flag;
  head.writeUInt16BE(7, 14);
  return Buffer.concat([head, payload]);
}
function encrypted(data: Buffer) {
  const preamble = Buffer.from("1234");
  const head = Buffer.alloc(6);
  head.writeUInt16BE(0x28 + data.length, 0);
  head.writeUInt32BE(1, 2);
  const hash = createHash("md5")
    .update(Buffer.concat([preamble, data]))
    .digest();
  const plain = Buffer.concat([head, hash, Buffer.alloc(16), preamble, data]);
  const padded = Buffer.concat([plain, Buffer.alloc((16 - (plain.length % 16)) % 16)]);
  const cipher = createCipheriv(
    "aes-128-cbc",
    createHash("md5").update(key, "ascii").digest(),
    Buffer.alloc(16),
  );
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}
function status(temperature = 26) {
  const blob = Buffer.alloc(125);
  blob.writeUInt32BE(0x2715, 0);
  blob[92] = temperature - 16;
  blob[94] = 0x21;
  blob[97] = 1;
  blob[102] = 59;
  return frame(0x64, encrypted(blob), 1);
}
async function peer(
  t: TestContext,
  mode: "complete" | "empty" | "truncated" | "control" | "follow-up",
) {
  const sockets = new Set<Socket>();
  let controls = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 6) {
        const size = 6 + buffer.readUInt16BE(4);
        if (buffer.length < size) return;
        const packet = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        const type = packet.readUInt32BE(0) - 0xea60;
        if (type === 0) {
          const hello = Buffer.alloc(8);
          hello.writeUInt32BE(1, 0);
          hello.writeUInt32BE(1, 4);
          socket.write(frame(1, hello));
        }
        if (type === 2) {
          if (mode === "empty") socket.end();
          else if (mode === "truncated")
            socket.end(Buffer.concat([status(), status().subarray(0, 25)]));
          else if (mode === "complete") socket.end(status());
          else if (mode === "follow-up" && controls > 0) socket.end(status(23));
          else
            socket.write(Buffer.concat([frame(3, encrypted(Buffer.from([0, 0, 0, 1]))), status()]));
        }
        if (type === 0x64) {
          controls++;
          socket.end(
            mode === "follow-up" ? frame(0x64, encrypted(Buffer.alloc(4)), 1) : status(23),
          );
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    controls: () => controls,
    open: async () => {
      const socket = createConnection({ host: "127.0.0.1", port });
      await once(socket, "connect");
      return socket;
    },
  };
}

test("a complete AC status survives a clean connection close", async (t) => {
  const ac = await peer(t, "complete");
  const state = await readDeviceStatus(device, ac.open);
  assert.equal(state.targetTemperature, 26);
  assert.equal(state.currentTemperature, 29.5);
});
test("a complete control reply survives a clean connection close", async (t) => {
  const ac = await peer(t, "control");
  const state = await controlDevice(device, { temperature: 23 }, undefined, ac.open);
  assert.equal(state.targetTemperature, 23);
  assert.equal(ac.controls(), 1);
});
for (const mode of ["empty", "truncated"] as const) {
  test("an empty or truncated AC reply remains an error: " + mode, async (t) => {
    const ac = await peer(t, mode);
    await assert.rejects(
      readDeviceStatus(device, ac.open),
      /supported status report|connection closed/,
    );
  });
}

test("a compact control acknowledgement followed by EOF uses a fresh status connection", async (t) => {
  const ac = await peer(t, "follow-up");
  const state = await controlDevice(device, { temperature: 23 }, undefined, ac.open);
  assert.equal(state.targetTemperature, 23);
  assert.equal(ac.controls(), 1, "A follow-up read must not resend the control");
});
