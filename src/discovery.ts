// Haier UDISCOVERY wire format adapted from haismart-local, MIT.
// See THIRD_PARTY_NOTICES.md for attribution and license.
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { validateHost } from "./devices.js";

export interface DiscoveredDevice {
  deviceId: string;
  host: string;
  uplusId: string;
}

export function discoveryQuery(): Buffer {
  const packet = Buffer.alloc(77);
  packet.write("Haier");
  packet.writeUInt32BE(0x6915, 5);
  packet.writeUInt32BE(56, 17);
  packet.write("2.0.0", 21 + 16);
  packet.write("UDISCOVERY_SDK", 21 + 24);
  return packet;
}

export function parseDiscoveryReply(packet: Buffer, host: string): DiscoveredDevice | null {
  if (
    packet.length < 73 ||
    packet.subarray(0, 5).toString() !== "Haier" ||
    packet.readUInt32BE(5) !== 0x684d
  )
    return null;
  const text = (bytes: Buffer) => bytes.toString("ascii").split("\0")[0].trim();
  let deviceId = text(packet.subarray(21, 37));
  if (!deviceId) {
    let offset = 73;
    for (let i = 0; i < Math.min(packet.readUInt32BE(69), 32) && offset + 2 <= packet.length; i++) {
      const type = packet[offset],
        length = packet[offset + 1];
      if (!type || offset + 2 + length > packet.length) break;
      if (type === 1) {
        deviceId = text(packet.subarray(offset + 2, offset + 2 + length));
        break;
      }
      offset += 2 + length;
    }
  }
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(deviceId)) return null;
  try {
    validateHost(host);
  } catch {
    return null;
  }
  // Use the sender's address, never an arbitrary address advertised in a reply.
  return { deviceId, host, uplusId: packet.subarray(37, 69).toString("hex") };
}

export function broadcastAddresses(): string[] {
  const result = new Set(["255.255.255.255"]);
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      try {
        validateHost(entry.address);
      } catch {
        continue;
      }
      const ip = entry.address.split(".").map(Number),
        mask = entry.netmask.split(".").map(Number);
      result.add(ip.map((byte, i) => byte | (255 ^ mask[i])).join("."));
    }
  return [...result];
}

export function discoverDevices(host?: string): Promise<DiscoveredDevice[]> {
  if (host) validateHost(host);
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map<string, DiscoveredDevice>();
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* may not have bound */
      }
      if (error)
        reject(
          new Error("LAN discovery failed. Try entering the AC's IP address. " + error.message),
        );
      else resolve([...found.values()]);
    };
    const timer = setTimeout(() => finish(), 3500);
    socket.on("error", finish);
    socket.on("message", (packet, sender) => {
      if (host && sender.address !== host) return;
      const device = parseDiscoveryReply(packet, sender.address);
      if (device && found.size < 128) found.set(device.deviceId.toLowerCase(), device);
    });
    socket.bind(host ? 0 : 7083, "0.0.0.0", () => {
      if (finished) return;
      socket.setBroadcast(!host);
      for (const address of host ? [host] : broadcastAddresses()) {
        socket.send(discoveryQuery(), 7083, address, (error) => {
          if (error) finish(error);
        });
      }
    });
  });
}
