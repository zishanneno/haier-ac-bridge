import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { BridgeDatabase } from "./database.js";
import { MissingLocalKeyError } from "./database.js";
import { validateDevice, validateHost, type DeviceConfig } from "./devices.js";
import { HaierKeyRefresher } from "./haier-cloud.js";
import { discoverDevices } from "./discovery.js";
import { BridgeAuth } from "./auth.js";
import {
  controlDevice,
  readDeviceStatus,
  LocalKeyVersionMismatchError,
  type ControlChanges,
} from "./protocol.js";
import { validateControls, validateSettings } from "./settings.js";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface AppOptions {
  root: string;
  version: string;
  database: BridgeDatabase;
  auth: BridgeAuth;
  cloud: Pick<HaierKeyRefresher, "signIn" | "signOut" | "listDevices" | "refreshDeviceKey">;
  discover?: typeof discoverDevices;
  readStatus?: typeof readDeviceStatus;
  control?: typeof controlDevice;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send a JSON request with Content-Type: application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 8192) throw new HttpError(413, "Request body is too large");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "JSON body must be an object");
  return value as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

export function createApp(options: AppOptions) {
  const { database: db, auth, cloud } = options;
  const swagger = dirname(createRequire(import.meta.url).resolve("swagger-ui-dist/package.json"));
  const assets: Record<string, [string, string]> = {
    "/": [join(options.root, "web/index.html"), "text/html"],
    "/app.js": [join(options.root, "web/app.js"), "application/javascript"],
    "/style.css": [join(options.root, "web/style.css"), "text/css"],
    "/docs": [join(options.root, "web/docs.html"), "text/html"],
    "/docs/": [join(options.root, "web/docs.html"), "text/html"],
    "/docs/swagger-ui.css": [join(swagger, "swagger-ui.css"), "text/css"],
    "/docs/swagger-ui-bundle.js": [join(swagger, "swagger-ui-bundle.js"), "application/javascript"],
    "/docs/init.js": [join(options.root, "web/docs.js"), "application/javascript"],
  };
  // Each AC gets one operation at a time, including edits/removal and key refreshes.
  const pending = new Map<string, Promise<unknown>>();
  function serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (pending.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    pending.set(id, result);
    void result
      .finally(() => {
        if (pending.get(id) === result) pending.delete(id);
      })
      .catch(() => undefined);
    return result;
  }
  async function withKey<T>(
    id: string,
    operation: (device: DeviceConfig) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(db.device(id));
    } catch (error) {
      if (!(error instanceof MissingLocalKeyError || error instanceof LocalKeyVersionMismatchError))
        throw error;
    }
    await cloud.refreshDeviceKey(db.definition(id).deviceId);
    return operation(db.device(id));
  }
  let discovery: ReturnType<typeof discoverDevices> | null = null;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const path = new URL(request.url || "/", "http://localhost").pathname;
      const method = request.method || "GET";
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
      const origin = request.headers.origin;
      if (
        request.headers["sec-fetch-site"] === "cross-site" ||
        (origin &&
          (() => {
            try {
              return new URL(origin).host !== request.headers.host;
            } catch {
              return true;
            }
          })())
      )
        throw new HttpError(403, "Open the bridge directly to make this request");
      if (method === "GET" && Object.hasOwn(assets, path)) {
        const [file, type] = assets[path];
        response.writeHead(200, { "Content-Type": type + "; charset=utf-8" });
        response.end(readFileSync(file));
        return;
      }
      if (method === "GET" && path === "/openapi.yaml") {
        response.writeHead(200, { "Content-Type": "application/yaml; charset=utf-8" });
        response.end(
          readFileSync(join(options.root, "openapi.yaml"), "utf8").replace(
            "version: __PACKAGE_VERSION__",
            "version: " + JSON.stringify(options.version),
          ),
        );
        return;
      }
      if (method === "GET" && path === "/health") {
        json(response, 200, { ok: true });
        return;
      }
      if (method === "POST" && path === "/v1/auth/login") {
        const payload = await body(request);
        if (!auth.login(request, response, payload.code)) {
          json(response, response.statusCode, {
            error:
              response.statusCode === 429
                ? "Too many attempts. Try again in a minute."
                : "That access code is incorrect. Check the bridge's startup log.",
          });
          return;
        }
        json(response, 200, { ok: true });
        return;
      }
      if (!auth.authorized(request))
        throw new HttpError(
          401,
          "Unlock the bridge with its access code, or send a valid API token",
        );
      if (method === "POST" && path === "/v1/auth/logout") {
        auth.logout(request, response);
        json(response, 200, { ok: true });
        return;
      }
      if (method === "GET" && path === "/v1/setup") {
        json(response, 200, {
          version: options.version,
          cloudConnected: !!db.session(),
          deviceCount: db.listDevices().length,
        });
        return;
      }
      if (method === "GET" && path === "/v1/token") {
        json(response, 200, { token: auth.apiToken });
        return;
      }
      if (path === "/v1/settings" && method === "GET") {
        json(response, 200, db.settings());
        return;
      }
      if (path === "/v1/settings" && method === "PUT") {
        const settings = validateSettings(await body(request));
        db.saveSettings(settings);
        json(response, 200, settings);
        return;
      }
      if (path === "/v1/cloud/login" && method === "POST") {
        const payload = await body(request);
        if (
          typeof payload.username !== "string" ||
          !payload.username.trim() ||
          payload.username.length > 320 ||
          typeof payload.password !== "string" ||
          !payload.password ||
          payload.password.length > 1024 ||
          typeof payload.zoneInfo !== "string" ||
          !/^\d{1,4}$/.test(payload.zoneInfo)
        )
          throw new HttpError(400, "Enter your Haismart login, password, and country calling code");
        try {
          await cloud.signIn({
            username: payload.username.trim(),
            password: payload.password,
            zoneInfo: payload.zoneInfo,
          });
        } catch (error) {
          throw new HttpError(
            502,
            "Haismart sign-in failed. Check your password and country. " + errorMessage(error),
          );
        }
        json(response, 200, { ok: true });
        return;
      }
      if (path === "/v1/cloud/session" && method === "DELETE") {
        await cloud.signOut();
        json(response, 200, { ok: true });
        return;
      }
      if (path === "/v1/cloud/devices" && method === "GET") {
        try {
          json(response, 200, await cloud.listDevices());
        } catch (error) {
          throw new HttpError(502, errorMessage(error));
        }
        return;
      }
      if (path === "/v1/discovery" && method === "POST") {
        const payload = await body(request),
          host = payload.host ? validateHost(payload.host) : undefined;
        if (discovery)
          throw new HttpError(409, "A discovery scan is already running. Try again shortly.");
        try {
          discovery = (options.discover ?? discoverDevices)(host);
          json(response, 200, await discovery);
        } finally {
          discovery = null;
        }
        return;
      }
      if (method === "GET" && path === "/v1/devices") {
        json(response, 200, db.listDevices());
        return;
      }
      if (method === "POST" && path === "/v1/devices") {
        const payload = await body(request),
          definition = validateDevice(payload);
        await serialized(definition.id, async () => {
          if (db.listDevices().some((d) => d.id === definition.id))
            throw new HttpError(409, "This device ID is already in use");
          db.saveDevice(definition, localKey(payload));
        });
        json(
          response,
          201,
          db.listDevices().find((d) => d.id === definition.id),
        );
        return;
      }
      const match = path.match(
        /^\/v1\/devices\/([a-z0-9][a-z0-9_-]{0,63})(?:\/(status|control|power|temperature|mode|fan|vertical-swing|horizontal-swing|eco|quiet|refresh-key))?$/,
      );
      if (!match) throw new HttpError(404, "Route not found");
      const [, id, action] = match;
      const payload = mutating && method !== "DELETE" ? await body(request) : {};
      const result = await serialized(id, async () => {
        if (!db.listDevices().some((d) => d.id === id)) throw new HttpError(404, "AC not found");
        if (!action && method === "DELETE") {
          db.removeDevice(id);
          return { ok: true };
        }
        if (!action && method === "PUT") {
          const definition = validateDevice({ ...db.definition(id), ...payload, id });
          db.saveDevice(definition, localKey(payload));
          return db.listDevices().find((d) => d.id === id);
        }
        if (action === "status" && method === "GET") {
          try {
            return { device: id, state: await withKey(id, options.readStatus ?? readDeviceStatus) };
          } catch (error) {
            throw new HttpError(502, errorMessage(error));
          }
        }
        if (action === "refresh-key" && method === "POST") {
          try {
            await cloud.refreshDeviceKey(db.definition(id).deviceId);
            return { ok: true };
          } catch (error) {
            throw new HttpError(502, errorMessage(error));
          }
        }
        if (method !== "POST" || !action || action === "status")
          throw new HttpError(405, "Method not allowed for this route");
        const aliases: Record<string, [string, string]> = {
          power: ["power", "on"],
          "vertical-swing": ["verticalSwing", "enabled"],
          "horizontal-swing": ["horizontalSwing", "enabled"],
          quiet: ["quiet", "enabled"],
        };
        const [key, field] = aliases[action] ?? [action, action];
        const changes: ControlChanges = validateControls(
          action === "control" ? payload : { [key]: payload[field] },
        );
        try {
          return {
            device: id,
            state: await withKey(id, (target) =>
              (options.control ?? controlDevice)(target, changes, db.settings()),
            ),
          };
        } catch (error) {
          throw new HttpError(502, errorMessage(error));
        }
      });
      json(response, 200, result);
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 400, {
        error: errorMessage(error),
      });
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 15_000;
  return server;
}

function localKey(
  payload: Record<string, unknown>,
): { localKey: string; localKeyVersion: number } | undefined {
  if (payload.localKey === undefined || payload.localKey === "") return undefined;
  if (
    typeof payload.localKey !== "string" ||
    !/^[a-fA-F0-9]{32}$/.test(payload.localKey) ||
    !Number.isSafeInteger(payload.localKeyVersion) ||
    Number(payload.localKeyVersion) < 1 ||
    Number(payload.localKeyVersion) > 0xffffffff
  ) {
    throw new HttpError(
      400,
      "Local key must be 32 hexadecimal characters, with a positive integer key version",
    );
  }
  return { localKey: payload.localKey, localKeyVersion: Number(payload.localKeyVersion) };
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
