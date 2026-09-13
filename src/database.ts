import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { DeviceConfig, DeviceDefinition } from "./devices.js";
import { DEFAULT_SETTINGS, type BridgeSettings } from "./settings.js";

export interface DeviceSummary extends DeviceDefinition {
  localKeyVersion: number | null;
  keyUpdatedAt: string | null;
}

export interface HaierSession {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  zoneInfo: string;
}

interface DeviceRow {
  id: DeviceDefinition["id"];
  name: string;
  host: string;
  device_id: string;
  uplus_id: string | null;
  local_key: string | null;
  local_key_version: number | null;
  key_updated_at: string | null;
}

interface SessionRow {
  client_id: string;
  access_token: string;
  refresh_token: string;
  zone_info: string;
}

export class MissingLocalKeyError extends Error {
  constructor(readonly id: DeviceDefinition["id"]) {
    super("No local key is stored for " + id);
  }
}

export class BridgeDatabase {
  private readonly db: Database.Database;

  constructor(databaseFile: string, definitions: readonly DeviceDefinition[] = []) {
    const directory = dirname(databaseFile);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new Database(databaseFile);
    chmodSync(databaseFile, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        device_id TEXT NOT NULL UNIQUE,
        uplus_id TEXT
      );
      CREATE TABLE IF NOT EXISTS local_keys (
        device_id TEXT PRIMARY KEY REFERENCES devices(device_id),
        local_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS haier_session (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        client_id TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        zone_info TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)",
    );
    const upsert = this.db.prepare(`
      INSERT INTO devices (id, name, host, device_id, uplus_id)
      VALUES (@id, @name, @host, @deviceId, @uplusId)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        host = excluded.host,
        device_id = excluded.device_id,
        uplus_id = excluded.uplus_id
    `);
    for (const definition of definitions) {
      upsert.run({ ...definition, uplusId: definition.uplusId ?? null });
    }
  }

  saveDevice(
    definition: DeviceDefinition,
    key?: { localKey: string; localKeyVersion: number },
  ): void {
    this.db.transaction(() => {
      const previous = this.db
        .prepare("SELECT device_id FROM devices WHERE id = ?")
        .get(definition.id) as { device_id: string } | undefined;
      if (previous && previous.device_id !== definition.deviceId) {
        throw new Error("A saved AC's Haier device ID cannot change; remove it and add a new AC");
      }
      if (
        this.db
          .prepare("SELECT id FROM devices WHERE lower(device_id) = lower(?) AND id != ?")
          .get(definition.deviceId, definition.id)
      ) {
        throw new Error("This Haier AC has already been added");
      }
      this.db
        .prepare(
          `INSERT INTO devices (id, name, host, device_id, uplus_id)
        VALUES (@id, @name, @host, @deviceId, @uplusId)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, host=excluded.host, uplus_id=excluded.uplus_id`,
        )
        .run({ ...definition, uplusId: definition.uplusId ?? null });
      if (key) this.saveLocalKey(definition.deviceId, key.localKey, key.localKeyVersion);
    })();
  }

  removeDevice(id: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM local_keys WHERE device_id IN (SELECT device_id FROM devices WHERE id = ?)",
        )
        .run(id);
      this.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
    })();
  }

  clearSession(): void {
    this.db.prepare("DELETE FROM haier_session").run();
  }

  settings(): BridgeSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE id = 1").get() as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as BridgeSettings) : structuredClone(DEFAULT_SETTINGS);
  }

  saveSettings(value: BridgeSettings): void {
    this.db
      .prepare(
        "INSERT INTO settings (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(value));
  }

  close(): void {
    this.db.close();
  }

  listDevices(): DeviceSummary[] {
    return this.rows().map((row) => ({
      id: row.id,
      name: row.name,
      host: row.host,
      deviceId: row.device_id,
      uplusId: row.uplus_id ?? undefined,
      localKeyVersion: row.local_key_version,
      keyUpdatedAt: row.key_updated_at,
    }));
  }

  definition(id: DeviceDefinition["id"]): DeviceDefinition {
    const row = this.row(id);
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      deviceId: row.device_id,
      uplusId: row.uplus_id ?? undefined,
    };
  }

  device(id: DeviceDefinition["id"]): DeviceConfig {
    const row = this.row(id);
    if (!row.local_key || row.local_key_version === null) {
      throw new MissingLocalKeyError(id);
    }
    return {
      ...this.definition(id),
      localKey: row.local_key,
      localKeyVersion: row.local_key_version,
    };
  }

  saveLocalKey(deviceId: string, localKey: string, version: number): void {
    if (!/^[a-f0-9]{32}$/i.test(localKey)) {
      throw new Error("Haier returned an invalid local key");
    }
    if (!Number.isSafeInteger(version) || version < 1 || version > 0xffffffff) {
      throw new Error("Haier returned an invalid local key version");
    }
    this.db
      .prepare(
        `
        INSERT INTO local_keys (device_id, local_key, version, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          local_key = excluded.local_key,
          version = excluded.version,
          updated_at = excluded.updated_at
      `,
      )
      .run(deviceId, localKey, version, new Date().toISOString());
  }

  session(): HaierSession | null {
    const row = this.db
      .prepare(
        "SELECT client_id, access_token, refresh_token, zone_info FROM haier_session WHERE singleton = 1",
      )
      .get() as SessionRow | undefined;
    return row
      ? {
          clientId: row.client_id,
          accessToken: row.access_token,
          refreshToken: row.refresh_token,
          zoneInfo: row.zone_info,
        }
      : null;
  }

  saveSession(session: HaierSession): void {
    this.db
      .prepare(
        `
        INSERT INTO haier_session
          (singleton, client_id, access_token, refresh_token, zone_info, updated_at)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          client_id = excluded.client_id,
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          zone_info = excluded.zone_info,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        session.clientId,
        session.accessToken,
        session.refreshToken,
        session.zoneInfo,
        new Date().toISOString(),
      );
  }

  private rows(): DeviceRow[] {
    return this.db
      .prepare(
        `
        SELECT d.id, d.name, d.host, d.device_id, d.uplus_id,
               k.local_key, k.version AS local_key_version, k.updated_at AS key_updated_at
        FROM devices d
        LEFT JOIN local_keys k ON k.device_id = d.device_id
        ORDER BY d.id
      `,
      )
      .all() as DeviceRow[];
  }

  private row(id: DeviceDefinition["id"]): DeviceRow {
    const row = this.rows().find((candidate) => candidate.id === id);
    if (!row) throw new Error("Unknown device " + id);
    return row;
  }
}
