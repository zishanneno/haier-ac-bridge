import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { BridgeDatabase } from "../src/database.js";
import { BridgeAuth } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { loadAccess } from "../src/config.js";
import { validateDevice } from "../src/devices.js";
import { validateControls, validateSettings } from "../src/settings.js";
import {
  resolvedControlChanges,
  LocalKeyVersionMismatchError,
  type AirConditionerState,
} from "../src/protocol.js";
import { parseCloudDevices, HaierKeyRefresher } from "../src/haier-cloud.js";
import { discoveryQuery, parseDiscoveryReply } from "../src/discovery.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const definition = {
  id: "guest-room",
  name: "Guest room",
  host: "192.168.1.50",
  deviceId: "AABBCCDDEEFF",
};
const localKey = "a".repeat(32);
const state: AirConditionerState = {
  power: false,
  targetTemperature: 23,
  currentTemperature: 27,
  outdoorTemperature: null,
  mode: "cool",
  fan: "low",
  verticalSwing: false,
  horizontalSwing: false,
  quiet: true,
  eco: "off",
};

function database() {
  const directory = mkdtempSync(join(tmpdir(), "haier-test-"));
  const db = new BridgeDatabase(join(directory, "data", "bridge.sqlite"));
  return {
    db,
    directory,
    close: () => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("fresh database works without a private device file and stores arbitrary rooms", () => {
  const fixture = database();
  try {
    assert.deepEqual(fixture.db.listDevices(), []);
    fixture.db.saveDevice(validateDevice(definition), { localKey, localKeyVersion: 1 });
    assert.equal(fixture.db.device("guest-room").localKey, localKey);
    assert.ok(!JSON.stringify(fixture.db.listDevices()).includes(localKey));
    fixture.db.saveDevice({ ...definition, name: "Study", host: "192.168.1.51" });
    assert.equal(fixture.db.device("guest-room").localKey, localKey);
    fixture.db.removeDevice("guest-room");
    assert.deepEqual(fixture.db.listDevices(), []);
  } finally {
    fixture.close();
  }
});

test("bad keys roll back device creation and duplicates cannot overwrite credentials", () => {
  const fixture = database();
  try {
    assert.throws(() => fixture.db.saveDevice(definition, { localKey: "bad", localKeyVersion: 1 }));
    assert.deepEqual(fixture.db.listDevices(), []);
    fixture.db.saveDevice(definition, { localKey, localKeyVersion: 1 });
    assert.throws(
      () => fixture.db.saveDevice({ ...definition, id: "another" }),
      /already been added/,
    );
    assert.throws(
      () => fixture.db.saveDevice({ ...definition, deviceId: "112233445566" }),
      /cannot change/,
    );
    assert.equal(fixture.db.device("guest-room").localKey, localKey);
  } finally {
    fixture.close();
  }
});

test("device keys, preferences, and cloud sessions survive restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "haier-restart-"));
  const file = join(directory, "data", "bridge.sqlite");
  let db = new BridgeDatabase(file);
  try {
    db.saveDevice(definition, { localKey, localKeyVersion: 2 });
    db.saveSettings({ startup: { temperature: 25, fan: "auto" }, linkQuietEco: false });
    db.saveSession({
      clientId: "test",
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
      zoneInfo: "92",
    });
    db.close();
    db = new BridgeDatabase(file);
    assert.equal(db.device(definition.id).localKeyVersion, 2);
    assert.equal(db.settings().startup.temperature, 25);
    assert.equal(db.session()?.refreshToken, "secret-refresh");
    db.clearSession();
    assert.equal(db.session(), null);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("access code and token persist in the data directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "haier-access-"));
  const previousData = process.env.DATA_DIR,
    previousToken = process.env.HAIER_API_TOKEN;
  delete process.env.DATA_DIR;
  delete process.env.HAIER_API_TOKEN;
  try {
    const first = loadAccess(directory),
      second = loadAccess(directory);
    assert.equal(first.apiToken, second.apiToken);
    assert.equal(first.accessCode, second.accessCode);
    assert.equal(first.apiToken.length, 64);
    if (process.platform !== "win32")
      assert.equal(statSync(join(first.dataDirectory, "access.json")).mode & 0o777, 0o600);
  } finally {
    if (previousData === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousData;
    if (previousToken === undefined) delete process.env.HAIER_API_TOKEN;
    else process.env.HAIER_API_TOKEN = previousToken;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configuration rejects unsafe hosts, malformed identifiers, and invalid controls", () => {
  for (const host of [
    "127.0.0.1",
    "169.254.169.254",
    "8.8.8.8",
    "example.com",
    "255.255.255.255",
    "224.0.0.1",
    "::1",
    "172.15.1.1",
    "172.32.1.1",
  ])
    assert.throws(() => validateDevice({ ...definition, host }));
  for (const host of ["192.168.0.255", "10.0.0.255", "172.16.0.255", "172.31.0.255"])
    assert.equal(validateDevice({ ...definition, host }).host, host);
  assert.throws(() => validateDevice({ ...definition, id: "../room" }));
  assert.throws(() => validateDevice({ ...definition, deviceId: "x".repeat(33) }));
  for (const temperature of [15, 31, 23.5, "23"])
    assert.throws(() => validateControls({ temperature }));
  assert.throws(() => validateControls({ power: "true" }));
  assert.throws(() => validateControls(JSON.parse('{"__proto__":{}}')));
  assert.throws(() => validateSettings({ startup: { power: true }, linkQuietEco: false }));
  assert.deepEqual(validateControls({ mode: "heating", eco: "close" }), {
    mode: "heat",
    eco: "off",
  });
});

test("power-on preserves existing settings unless defaults were explicitly configured", () => {
  assert.deepEqual(resolvedControlChanges(state, { power: true }), { power: true });
  const settings = {
    startup: { temperature: 26, quiet: false, eco: "l3" as const },
    linkQuietEco: false,
  };
  assert.deepEqual(resolvedControlChanges(state, { power: true, temperature: 22 }, settings), {
    power: true,
    temperature: 22,
    quiet: false,
    eco: "l3",
  });
  assert.deepEqual(
    resolvedControlChanges({ ...state, power: true }, { temperature: 22 }, settings),
    { temperature: 22 },
  );
  assert.deepEqual(resolvedControlChanges(state, { quiet: true }), { quiet: true });
  assert.deepEqual(
    resolvedControlChanges(state, { quiet: true, eco: "l2" }, { startup: {}, linkQuietEco: true }),
    { quiet: true, eco: "l2" },
  );
  assert.deepEqual(
    resolvedControlChanges(state, { quiet: true }, { startup: {}, linkQuietEco: true }),
    { quiet: true, eco: "off" },
  );
});

test("discovery parser accepts the wire identity but never a spoofed advertised host", () => {
  const query = discoveryQuery();
  assert.equal(query.readUInt32BE(5), 0x6915);
  assert.equal(query.length, 77);
  const reply = Buffer.alloc(300);
  reply.write("Haier");
  reply.writeUInt32BE(0x684d, 5);
  reply.write("AABBCCDDEEFF", 21);
  reply.fill(0x12, 37, 69);
  reply.write("8.8.8.8", 229);
  assert.deepEqual(parseDiscoveryReply(reply, "192.168.1.80"), {
    deviceId: "AABBCCDDEEFF",
    host: "192.168.1.80",
    uplusId: "12".repeat(32),
  });
  assert.equal(parseDiscoveryReply(reply, "8.8.8.8"), null);
  assert.equal(parseDiscoveryReply(Buffer.alloc(10), "192.168.1.80"), null);
  reply.writeUInt32BE(0x1234, 5);
  assert.equal(parseDiscoveryReply(reply, "192.168.1.80"), null);
});

test("cloud response mapping handles missing optional fields and rejects unfamiliar envelopes", () => {
  assert.deepEqual(
    parseCloudDevices({
      data: {
        deviceInfos: [
          {
            baseInfo: {
              deviceId: "AABBCCDDEEFF",
              deviceName: "Guest room",
              wifiType: "12".repeat(32),
            },
          },
        ],
      },
    }),
    [
      {
        deviceId: "AABBCCDDEEFF",
        name: "Guest room",
        uplusId: "12".repeat(32),
        model: "",
        deviceType: "",
      },
    ],
  );
  assert.throws(() => parseCloudDevices({ data: {} }), /unfamiliar/);
});

test("HTTP onboarding, auth, CRUD, validation, key retry, and settings end to end", async (t) => {
  const fixture = database();
  let refreshes = 0,
    reads = 0,
    receivedChanges: unknown;
  const cloud = {
    async signIn() {
      fixture.db.saveSession({
        clientId: "test",
        accessToken: "private-token",
        refreshToken: "private-refresh",
        zoneInfo: "92",
      });
    },
    async signOut() {
      fixture.db.clearSession();
    },
    async listDevices() {
      return [];
    },
    async refreshDeviceKey(id: string) {
      refreshes++;
      fixture.db.saveLocalKey(id, localKey, 2);
    },
  };
  const server = createApp({
    root,
    version: "0.1.0",
    database: fixture.db,
    auth: new BridgeAuth("t".repeat(64), "1234567890abcdef"),
    cloud,
    discover: async () => [
      { deviceId: definition.deviceId, host: definition.host, uplusId: "12".repeat(32) },
    ],
    readStatus: async (device) => {
      reads++;
      if (device.localKeyVersion === 1) throw new LocalKeyVersionMismatchError(2, 1);
      return state;
    },
    control: async (_device, changes, settings) => {
      receivedChanges = resolvedControlChanges(state, changes, settings);
      return { ...state, power: true };
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  async function call(
    path: string,
    method = "GET",
    payload?: unknown,
    headers: Record<string, string> = {},
  ) {
    return fetch(base + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  }
  try {
    await t.test("public pages load but configuration is protected", async () => {
      assert.equal((await call("/")).status, 200);
      assert.equal((await call("/health")).status, 200);
      assert.equal((await call("/v1/devices")).status, 401);
      assert.equal((await call("/v1/token")).status, 401);
      assert.equal(
        (await call("/v1/devices", "GET", undefined, { "X-API-Key": "t".repeat(64) })).status,
        200,
      );
      assert.match(await (await call("/openapi.yaml")).text(), /version: "0.1.0"/);
    });
    await t.test("code login sets a private session and blocks cross-site writes", async () => {
      assert.equal((await call("/v1/auth/login", "POST", { code: "wrong" })).status, 401);
      const response = await call("/v1/auth/login", "POST", { code: "1234-5678-90ab-cdef" });
      assert.equal(response.status, 200);
      const setCookie = response.headers.get("set-cookie")!;
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      cookie = setCookie.split(";")[0];
      assert.equal(
        (
          await call(
            "/v1/settings",
            "PUT",
            { startup: {}, linkQuietEco: false },
            { Origin: "https://attacker.example" },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(base + "/v1/devices", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "text/plain" },
            body: "{}",
          })
        ).status,
        415,
      );
      assert.equal(
        (
          await fetch(base + "/v1/devices", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: "[",
          })
        ).status,
        400,
      );
      assert.equal((await call("/v1/devices", "POST", { data: "x".repeat(9000) })).status, 413);
    });
    await t.test("empty install, sign-in, discovery and custom room creation work", async () => {
      assert.deepEqual(await (await call("/v1/devices")).json(), []);
      assert.equal(
        (
          await call("/v1/cloud/login", "POST", {
            username: "test@example.com",
            password: "never-store-me",
            zoneInfo: "92",
          })
        ).status,
        200,
      );
      assert.equal((await (await call("/v1/setup")).json()).cloudConnected, true);
      assert.equal((await (await call("/v1/discovery", "POST", {})).json()).length, 1);
      assert.equal((await call("/v1/devices", "POST", definition)).status, 201);
      assert.equal((await call("/v1/devices", "POST", definition)).status, 409);
      assert.equal((await call("/v1/devices/guest-room/status")).status, 200);
      assert.equal(refreshes, 1);
      assert.equal(reads, 1);
      const publicJSON = JSON.stringify(await (await call("/v1/devices")).json());
      assert.ok(!publicJSON.includes(localKey));
      assert.ok(!publicJSON.includes("private-token"));
    });
    await t.test(
      "rotated keys retry once, and invalid controls never reach the device",
      async () => {
        fixture.db.saveLocalKey(definition.deviceId, localKey, 1);
        assert.equal((await call("/v1/devices/guest-room/status")).status, 200);
        assert.equal(refreshes, 2);
        assert.equal(reads, 3);
        assert.equal(
          (await call("/v1/devices/guest-room/temperature", "POST", { temperature: 35 })).status,
          400,
        );
        assert.equal(receivedChanges, undefined);
        assert.equal(
          (await call("/v1/settings", "PUT", { startup: { temperature: 25 }, linkQuietEco: false }))
            .status,
          200,
        );
        assert.equal(
          (await call("/v1/devices/guest-room/power", "POST", { on: true })).status,
          200,
        );
        assert.deepEqual(receivedChanges, { power: true, temperature: 25 });
        assert.equal(
          (await call("/v1/devices/guest-room", "PUT", { host: "192.168.1.60", name: "New room" }))
            .status,
          200,
        );
        assert.equal(fixture.db.definition("guest-room").host, "192.168.1.60");
      },
    );
    await t.test("disconnect, remove, and logout revoke the corresponding access", async () => {
      assert.equal((await call("/v1/cloud/session", "DELETE")).status, 200);
      assert.equal(fixture.db.session(), null);
      assert.equal((await call("/v1/devices/guest-room", "DELETE")).status, 200);
      assert.equal((await call("/v1/devices/guest-room/status")).status, 404);
      assert.equal((await call("/v1/auth/logout", "POST")).status, 200);
      assert.equal((await call("/v1/devices")).status, 401);
      for (let i = 0; i < 5; i++)
        assert.equal((await call("/v1/auth/login", "POST", { code: "wrong" })).status, 401);
      assert.equal(
        (await call("/v1/auth/login", "POST", { code: "1234567890abcdef" })).status,
        429,
      );
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fixture.close();
  }
});

test("Haismart onboarding uses signed requests and never persists the submitted password", async (t) => {
  const fixture = database();
  const requests: Array<{
    url: string;
    method: string;
    body: unknown;
    headers: HeadersInit | undefined;
  }> = [];
  const fakeFetch = t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body,
        headers: init?.headers,
      });
      const data = url.endsWith("/user/devices")
        ? { deviceInfos: [{ baseInfo: { deviceId: "AABBCCDDEEFF", deviceName: "Test AC" } }] }
        : { tokenInfo: { accessToken: "session-token", refreshToken: "renewable-token" } };
      return new Response(JSON.stringify({ retCode: "00000", data }), { status: 200 });
    },
  );
  try {
    const cloud = new HaierKeyRefresher(fixture.db, null);
    await cloud.signIn({
      username: "demo@example.com",
      password: "private-login-password",
      zoneInfo: "92",
    });
    assert.equal(fixture.db.session()?.accessToken, "session-token");
    assert.ok(!JSON.stringify(fixture.db.session()).includes("private-login-password"));
    assert.ok(!String(requests[0].body).includes("private-login-password"));
    assert.equal((await cloud.listDevices())[0].name, "Test AC");
    const get = requests.find((request) => request.method === "GET")!;
    assert.ok(get.url.endsWith("/uplussea/devices/v2/user/devices"));
    assert.equal(get.body, undefined);
    assert.match((get.headers as Record<string, string>).sign, /^[a-f0-9]{64}$/);
    await cloud.signOut();
    assert.equal(fixture.db.session(), null);
    await assert.rejects(cloud.listDevices(), /Sign in to Haismart/);
  } finally {
    fakeFetch.mock.restore();
    fixture.close();
  }
});

test("a failed Haismart login preserves an existing session", async (t) => {
  const fixture = database();
  fixture.db.saveSession({
    clientId: "old",
    accessToken: "old-token",
    refreshToken: "old-refresh",
    zoneInfo: "92",
  });
  const fakeFetch = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ retCode: "21001" }), { status: 200 }),
  );
  try {
    await assert.rejects(
      new HaierKeyRefresher(fixture.db, null).signIn({
        username: "demo@example.com",
        password: "bad-password",
        zoneInfo: "92",
      }),
      /rejected/,
    );
    assert.equal(fixture.db.session()?.accessToken, "old-token");
  } finally {
    fakeFetch.mock.restore();
    fixture.close();
  }
});
