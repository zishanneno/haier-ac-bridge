import { isIP } from "node:net";

export interface DeviceDefinition {
  id: string;
  name: string;
  host: string;
  deviceId: string;
  uplusId?: string;
}

export interface DeviceConfig extends DeviceDefinition {
  localKey: string;
  localKeyVersion: number;
}

export function validateHost(value: unknown): string {
  if (typeof value !== "string" || isIP(value) !== 4) {
    throw new Error("Enter the AC's local IPv4 address, for example 192.168.1.50");
  }
  const [a, b] = value.split(".").map(Number);
  // A .255 host can be unicast on a /23 or larger subnet. The address alone
  // cannot identify a subnet's broadcast address; enforce the private ranges.
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) {
    throw new Error("Use a private home-network address (10.x, 172.16–31.x, or 192.168.x)");
  }
  return value;
}

export function validateDevice(value: Record<string, unknown>): DeviceDefinition {
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.id)) {
    throw new Error("Device ID must be 1–64 lowercase letters, numbers, hyphens, or underscores");
  }
  if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 80) {
    throw new Error("Give the AC a name of 1–80 characters");
  }
  if (typeof value.deviceId !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(value.deviceId)) {
    throw new Error("Haier device ID must be 1–32 letters, numbers, hyphens, or underscores");
  }
  if (
    value.uplusId !== undefined &&
    value.uplusId !== "" &&
    (typeof value.uplusId !== "string" || !/^[a-fA-F0-9]{64}$/.test(value.uplusId))
  ) {
    throw new Error("Model identifier must contain 64 hexadecimal characters");
  }
  return {
    id: value.id,
    name: value.name.trim(),
    host: validateHost(value.host),
    deviceId: value.deviceId,
    uplusId: value.uplusId ? String(value.uplusId).toLowerCase() : undefined,
  };
}
