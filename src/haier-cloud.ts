import {
  constants,
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from "node:crypto";

import mqtt, { type MqttClient } from "mqtt";

import { type BridgeDatabase, type HaierSession } from "./database.js";

const APP_ID = "MB-SHEYJDNYB-0001";
const APP_KEY = "5ff4067f62705b9f205ed5277648de3a";
const APP_VERSION = "5.5.0";
const LOGIN_HOST = "uhome-sea.haieriot.net";
const UHOME_HOST = "uhome-sgp.haieriot.net";
const GATEWAY_HOST = "gw-sgp.haieriot.net";
const GATEWAY_PORT = 58702;
const PACKAGE = "com.haier.uhome.uplus.seasia";
const LOGIN_PATH = "/uplussea/accounts/v2/login";
const REFRESH_PATH = "/uplussea/accounts/v1/user/refreshToken";
const LOGIN_PUBKEY_B64 =
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCpBUQQP/sCtV6UK4mDD6Qr3OKMuWhVuc7OXj+YHNyTGip0jXR1" +
  "PSMPshC6fql/GPMUMhZ2Ler/Yf5UihrgNkQsPK1ePu2lBntZp9B5tJza58fCKDtLeSvU6Z+VgFQsjJ9dcv0sw7P8" +
  "EH5HhvXTCcckpqCGMmIBiur59U06GJIQMQIDAQAB";

export interface HaierCredentials {
  username: string;
  password: string;
  zoneInfo: string;
}

interface GatewayCredentials {
  clientId: string;
  username: string;
  password: string;
  publishTopic: string;
  subscribeTopic: string;
}

interface LocalKeyReply {
  sn?: unknown;
  errNo?: unknown;
  key?: unknown;
  vers?: unknown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " response was not an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tokenInfo(response: unknown): Record<string, unknown> {
  const root = object(response, "Haier");
  const data = object(root.data ?? root, "Haier token");
  return object(data.tokenInfo ?? data, "Haier token");
}

function signature(path: string, body: string, timestamp: string): string {
  const compactBody = body.replace(/[ \t\r\n]/g, "");
  return createHash("sha256")
    .update(path + compactBody + APP_ID + APP_KEY + timestamp, "utf8")
    .digest("hex");
}

class HaierHttpError extends Error {
  constructor(readonly status: number) {
    super("Haier returned HTTP " + status);
  }
}

async function request(
  session: HaierSession,
  host: string,
  path: string,
  method: "POST" | "GET",
  payload?: unknown,
): Promise<unknown> {
  const body = method === "GET" ? "" : JSON.stringify(payload);
  const timestamp = String(Date.now());
  let response: Response;
  let responseText: string;
  try {
    response = await fetch("https://" + host + path, {
      method,
      headers: {
        appId: APP_ID,
        appVersion: APP_VERSION,
        apiVersion: "v1",
        clientId: session.clientId,
        sequenceId: timestamp + "000010",
        accessToken: session.accessToken,
        sign: signature(path, body, timestamp),
        timestamp,
        language: "en-us",
        timezone: "8",
        zoneInfo: session.zoneInfo,
        "Content-Type": "application/json;charset=UTF-8",
      },
      body: method === "GET" ? undefined : body,
      signal: AbortSignal.timeout(15000),
    });
    responseText = await response.text();
  } catch (error) {
    throw new Error(
      error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
        ? "Haier request timed out. Try again shortly."
        : "Could not reach Haier. Check your Internet connection and try again.",
      { cause: error },
    );
  }
  // HTTP authentication failures can have an empty or non-JSON error body.
  if (!response.ok) throw new HaierHttpError(response.status);
  let json: unknown;
  try {
    json = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error("Haier returned non-JSON HTTP " + response.status);
  }
  const root = object(json, "Haier");
  if (root.retCode && String(root.retCode) !== "00000") {
    throw new Error("Haier rejected the request (" + String(root.retCode) + ")");
  }
  return json;
}

function encryptedPassword(password: string): { password: string; sesame: string } {
  let aesKey = "";
  for (const byte of randomBytes(16)) aesKey += String(byte % 10);
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey));
  const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]).toString(
    "base64",
  );
  const publicKey = createPublicKey({
    key: Buffer.from(LOGIN_PUBKEY_B64, "base64"),
    format: "der",
    type: "spki",
  });
  const sesame = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(aesKey, "utf8"),
  ).toString("base64");
  return { password: encrypted, sesame };
}

async function login(credentials: HaierCredentials): Promise<HaierSession> {
  const session: HaierSession = {
    clientId: randomBytes(16).toString("hex").toUpperCase(),
    accessToken: "",
    refreshToken: "",
    zoneInfo: credentials.zoneInfo,
  };
  const encrypted = encryptedPassword(credentials.password);
  const response = await request(session, LOGIN_HOST, LOGIN_PATH, "POST", {
    username: credentials.username,
    password: encrypted.password,
    sesame: encrypted.sesame,
  });
  const tokens = tokenInfo(response);
  session.accessToken =
    text(tokens.uhomeAccessToken) || text(tokens.accountToken) || text(tokens.accessToken);
  session.refreshToken = text(tokens.refreshToken);
  if (!session.accessToken || !session.refreshToken) {
    throw new Error("Haier login did not return a usable session");
  }
  return session;
}

async function refresh(session: HaierSession): Promise<HaierSession> {
  const response = await request(session, UHOME_HOST, REFRESH_PATH, "POST", {
    refreshToken: session.refreshToken,
  });
  const tokens = tokenInfo(response);
  const accessToken =
    text(tokens.uhomeAccessToken) || text(tokens.accountToken) || text(tokens.accessToken);
  if (!accessToken) throw new Error("Haier session refresh did not return an access token");
  return {
    ...session,
    accessToken,
    refreshToken: text(tokens.refreshToken) || session.refreshToken,
  };
}

function gatewayCredentials(session: HaierSession): GatewayCredentials {
  const clientId = createHash("md5")
    .update(session.clientId + "_" + PACKAGE, "utf8")
    .digest("hex");
  let body = "";
  for (const byte of randomBytes(8)) body += String(byte % 10);
  const salt = Buffer.from("haier_sdk", "utf8");
  const block = Buffer.concat([Buffer.from([0, salt.length]), salt, Buffer.alloc(5)]);
  const cipher = createCipheriv(
    "aes-128-cbc",
    createHash("md5").update(body, "utf8").digest(),
    Buffer.alloc(16),
  );
  cipher.setAutoPadding(false);
  return {
    clientId,
    username: "01" + body,
    password: Buffer.concat([cipher.update(block), cipher.final()]).toString("hex"),
    publishTopic: "Client/" + clientId + "/Business/Up",
    subscribeTopic: "Client/" + clientId + "/Business/Down",
  };
}

function keyRequest(deviceId: string, accessToken: string, serial: string): string {
  const data = Buffer.from(JSON.stringify({ sn: serial, dev: deviceId, flag: 0 }), "utf8").toString(
    "base64",
  );
  return JSON.stringify({ type: "devLocalkey", data, tokens: [accessToken] });
}

function parseKeyReply(payload: Buffer): LocalKeyReply | null {
  try {
    const outer = object(JSON.parse(payload.toString("utf8")), "gateway");
    if (outer.type !== "devLocalkey" || typeof outer.data !== "string") return null;
    return object(
      JSON.parse(Buffer.from(outer.data, "base64").toString("utf8")),
      "gateway key",
    ) as LocalKeyReply;
  } catch {
    return null;
  }
}

async function connectGateway(
  credentials: GatewayCredentials,
  connector: typeof mqtt.connect,
): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = connector("mqtts://" + GATEWAY_HOST + ":" + GATEWAY_PORT, {
      clientId: credentials.clientId,
      username: credentials.username,
      password: credentials.password,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 8000,
    });
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      client.removeListener("connect", ready);
      client.removeListener("close", closed);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      client.end(true);
      reject(error);
    };
    const closed = () => fail(new Error("Haier gateway closed before connecting. Try again."));
    const ready = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(client);
    };
    // MQTT.js cancels its CONNACK timeout on close. Own the deadline so every
    // attempt settles and releases the serialized cloud queue.
    const timer = setTimeout(() => fail(new Error("Haier gateway connection timed out")), 8000);
    // Keep the guarded handler for late errors during forced close or before
    // fetchKey attaches its handler; it becomes a no-op after settlement.
    client.on("error", fail);
    client.once("close", closed);
    client.once("connect", ready);
  });
}

async function fetchKey(
  session: HaierSession,
  deviceId: string,
  connector: typeof mqtt.connect,
): Promise<{ key: string; version: number }> {
  const credentials = gatewayCredentials(session);
  const client = await connectGateway(credentials, connector);
  client.on("error", () => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Haier gateway subscription timed out")),
        8000,
      );
      client.subscribe(credentials.subscribeTopic, { qos: 0 }, (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
    const serial = String(Date.now() % 1_000_000_000);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Haier did not return a local key")), 8000);
      const finish = (error?: Error, value?: { key: string; version: number }) => {
        clearTimeout(timer);
        client.removeListener("message", onMessage);
        if (error) reject(error);
        else if (value) resolve(value);
      };
      const onMessage = (_topic: string, payload: Buffer) => {
        const answer = parseKeyReply(payload);
        if (!answer || String(answer.sn) !== serial) return;
        const key = text(answer.key);
        const version = Number(answer.vers);
        if (answer.errNo || !/^[a-f0-9]{32}$/i.test(key) || !Number.isInteger(version)) {
          finish(new Error("Haier did not return a valid local key"));
          return;
        }
        finish(undefined, { key, version });
      };
      client.on("message", onMessage);
      client.publish(credentials.publishTopic, keyRequest(deviceId, session.accessToken, serial), {
        qos: 0,
      });
    });
  } finally {
    client.end(true);
  }
}

export interface CloudDevice {
  deviceId: string;
  name: string;
  uplusId: string;
  model: string;
  deviceType: string;
}

// Response fields and endpoint documented by haismart-local (MIT); see THIRD_PARTY_NOTICES.md.
export function parseCloudDevices(response: unknown): CloudDevice[] {
  const root = object(response, "Haier device list");
  const data = object(root.data, "Haier device list");
  if (!Array.isArray(data.deviceInfos)) throw new Error("Haier returned an unfamiliar device list");
  return data.deviceInfos
    .map((item: unknown) => {
      const entry = object(item, "Haier device");
      const base = object(entry.baseInfo, "Haier device");
      const extra =
        entry.extendedInfo && typeof entry.extendedInfo === "object"
          ? (entry.extendedInfo as Record<string, unknown>)
          : {};
      return {
        deviceId: text(base.deviceId),
        name: text(base.deviceName) || "Haier AC",
        uplusId: text(base.wifiType),
        model: text(extra.model),
        deviceType: text(base.deviceType),
      };
    })
    .filter((item) => /^[a-zA-Z0-9_-]{1,32}$/.test(item.deviceId));
}

export class HaierKeyRefresher {
  constructor(
    private readonly database: BridgeDatabase,
    private credentials: HaierCredentials | null,
    private readonly connector: typeof mqtt.connect = mqtt.connect,
  ) {}

  private pending: Promise<unknown> = Promise.resolve();

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  signIn(credentials: HaierCredentials): Promise<void> {
    return this.serialized(async () => {
      const session = await login(credentials);
      this.database.saveSession(session);
      // Retain renewable tokens, not the submitted password.
      this.credentials = null;
    });
  }

  signOut(): Promise<void> {
    return this.serialized(async () => {
      this.credentials = null;
      this.database.clearSession();
    });
  }

  listDevices(): Promise<CloudDevice[]> {
    return this.serialized(async () => {
      const session = await this.liveSession();
      return parseCloudDevices(
        await request(session, UHOME_HOST, "/uplussea/devices/v2/user/devices", "GET"),
      );
    });
  }

  async refreshDeviceKey(deviceId: string): Promise<void> {
    return this.serialized(() => this.refreshKey(deviceId));
  }

  private async refreshKey(deviceId: string): Promise<void> {
    const session = await this.liveSession();
    const key = await fetchKey(session, deviceId, this.connector);
    this.database.saveLocalKey(deviceId, key.key, key.version);
  }

  private async liveSession(): Promise<HaierSession> {
    const saved = this.database.session();
    if (saved) {
      try {
        const refreshed = await refresh(saved);
        this.database.saveSession(refreshed);
        return refreshed;
      } catch (error) {
        // Preserve saved credentials and the actual error for outages, rate
        // limits, malformed replies, and unknown vendor codes. Only an explicit
        // HTTP authentication rejection warrants automatic password login.
        if (!(error instanceof HaierHttpError) || ![401, 403].includes(error.status)) throw error;
        if (!this.credentials) {
          throw new Error(
            "Haier rejected the saved session. Open Add AC and sign in to Haismart again.",
          );
        }
      }
    }
    if (!this.credentials) {
      throw new Error("Sign in to Haismart in Add AC, or supply a local key in Advanced setup.");
    }
    const session = await login(this.credentials);
    this.database.saveSession(session);
    return session;
  }
}
