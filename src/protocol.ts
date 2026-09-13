import { createCipheriv, createDecipheriv, createHash, randomInt } from "node:crypto";
import { createConnection, Socket } from "node:net";

import type { DeviceConfig } from "./devices.js";
import { DEFAULT_SETTINGS, type BridgeSettings } from "./settings.js";

const USS_PORT = 56800;
const ZERO_IV = Buffer.alloc(16);
const TYPE_BYTE = 0x01;
const HELLO = 0;
const HELLO_RESPONSE = 1;
const HELLO_DONE = 2;
const HELLO_DONE_RESPONSE = 3;
const BIZ_FLAG = 1;
const COLLECT_IDLE_MS = 600;
type Bytes = Uint8Array<ArrayBufferLike>;
const EXTENDED46_UPLUS_ID = "2008610800820324021200118017740000000000000000000000000000000040";
const EXTENDED46_STATUS_LENGTHS = new Set([209, 210]);

export type HvacMode = "auto" | "cool" | "dry" | "heat" | "fan";
export type EcoMode = "off" | "l1" | "l2" | "l3";
export type FanSpeed = "high" | "medium" | "low" | "auto";

export interface AirConditionerState {
  power: boolean;
  targetTemperature: number;
  currentTemperature: number | null;
  outdoorTemperature: number | null;
  mode: HvacMode | null;
  fan: FanSpeed | null;
  verticalSwing: boolean | null;
  horizontalSwing: boolean | null;
  quiet: boolean;
  eco: EcoMode | null;
}

export interface ControlChanges {
  power?: boolean;
  temperature?: number;
  mode?: HvacMode;
  fan?: FanSpeed;
  verticalSwing?: boolean;
  horizontalSwing?: boolean;
  eco?: EcoMode;
  quiet?: boolean;
}

interface Message {
  infoType: number;
  flag: number;
  session: number;
  payload: Buffer;
}

class ProtocolError extends Error {}

export class LocalKeyVersionMismatchError extends ProtocolError {
  constructor(
    readonly deviceVersion: number,
    readonly storedVersion: number,
  ) {
    super(
      "AC local key version " + deviceVersion + " differs from stored version " + storedVersion,
    );
  }
}

class ReadTimeout extends Error {}
class ConnectionClosed extends ProtocolError {}

class SocketReader {
  private buffer = Buffer.alloc(0);
  private readonly waiters: Array<{
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private closed: Error | null = null;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      if (this.buffer.length + chunk.length > 262144) {
        this.fail(new ProtocolError("AC sent too much buffered data"));
        socket.destroy();
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      try {
        this.flush();
      } catch (error) {
        this.fail(error instanceof Error ? error : new ProtocolError("Invalid AC frame"));
        socket.destroy();
      }
    });
    socket.on("error", (error: Error) => this.fail(error));
    socket.on("close", () => this.fail(new ConnectionClosed("AC connection closed")));
  }

  get hasBufferedData(): boolean {
    return this.buffer.length > 0;
  }

  next(timeoutMs: number): Promise<Message> {
    const message = this.take();
    if (message) return Promise.resolve(message);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(resolve);
        reject(new ReadTimeout("AC response timed out"));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private removeWaiter(resolve: (message: Message) => void): void {
    const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  private flush(): void {
    while (this.waiters.length > 0) {
      const message = this.take();
      if (!message) return;
      const waiter = this.waiters.shift();
      if (!waiter) return;
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private take(): Message | null {
    if (this.buffer.length < 6) return null;
    const length = this.buffer.readUInt16BE(4);
    const total = 6 + length;
    if (total < 16) throw new ProtocolError("Invalid uSS frame length");
    if (this.buffer.length < total) return null;
    const raw = this.buffer.subarray(0, total);
    this.buffer = this.buffer.subarray(total);
    return {
      infoType: raw.readUInt32BE(0) - 0xea60,
      flag: raw[7],
      session: raw.readUInt16BE(14),
      payload: raw.subarray(16),
    };
  }
}

function aesKey(localKey: string): Buffer {
  return createHash("md5").update(localKey, "ascii").digest();
}

function md5(data: Bytes): Buffer {
  return createHash("md5").update(data).digest();
}

function encodeMessage(
  infoType: number,
  sequence: number,
  payload: Bytes = Buffer.alloc(0),
  flag = 0,
  session = 0,
): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(0xea60 + infoType, 0);
  header.writeUInt16BE(payload.length + 0x0a, 4);
  header[6] = TYPE_BYTE;
  header[7] = flag;
  header.writeUInt32BE(sequence >>> 0, 8);
  header.writeUInt16BE(session, 14);
  return Buffer.concat([header, payload]);
}

function helloMessage(deviceId: string): Buffer {
  const device = Buffer.alloc(32);
  Buffer.from(deviceId, "ascii").copy(device);
  return encodeMessage(HELLO, 1, device);
}

function helloDoneMessage(session: number): Buffer {
  return encodeMessage(HELLO_DONE, 2, Buffer.alloc(0), 0, session);
}

function decryptBiz(ciphertext: Buffer, localKey: string): { sequence: number; data: Buffer } {
  const length = Math.floor(ciphertext.length / 16) * 16;
  if (length < 48) throw new ProtocolError("Encrypted payload is too short");
  const decipher = createDecipheriv("aes-128-cbc", aesKey(localKey), ZERO_IV);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, length)), decipher.final()]);
  const rawLength = plain.readUInt16BE(0);
  const dataLength = rawLength - 0x28;
  if (dataLength < 0 || 0x2a + dataLength > plain.length) {
    throw new ProtocolError("Invalid encrypted payload length");
  }
  const expected = plain.subarray(6, 22);
  const actual = md5(plain.subarray(0x26, 0x2a + dataLength));
  if (!actual.equals(expected)) throw new ProtocolError("Local key did not decrypt AC payload");
  return {
    sequence: plain.readUInt32BE(2),
    data: plain.subarray(0x2a, 0x2a + dataLength),
  };
}

function encryptBiz(sequence: number, data: Bytes, localKey: string): Buffer {
  const nonce = String(randomInt(10000, 100000));
  const preamble = Buffer.from(nonce.slice(0, 4), "ascii");
  const head = Buffer.alloc(6);
  head.writeUInt16BE(0x28 + data.length, 0);
  head.writeUInt32BE(sequence >>> 0, 2);
  let plain = Buffer.concat([
    head,
    md5(Buffer.concat([preamble, data])),
    Buffer.alloc(16),
    preamble,
    data,
  ]);
  const padding = (16 - (plain.length % 16)) % 16;
  if (padding) plain = Buffer.concat([plain, Buffer.alloc(padding)]);
  const cipher = createCipheriv("aes-128-cbc", aesKey(localKey), ZERO_IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final(), Buffer.from(nonce, "ascii")]);
}

function buildEpp(command: Bytes, data: Bytes = Buffer.alloc(0)): Buffer {
  const payload = Buffer.concat([Buffer.alloc(6), Buffer.from([1]), command, data]);
  const length = payload.length + 1;
  const body = Buffer.concat([Buffer.from([length]), payload]);
  let checksum = 0;
  for (const byte of body) checksum = (checksum + byte) & 0xff;
  return Buffer.concat([Buffer.from([0xff, 0xff]), body, Buffer.from([checksum])]);
}

function buildControlRequest(epp: Bytes, deviceId: string, counter: number): Buffer {
  const device = Buffer.alloc(32);
  Buffer.from(deviceId, "ascii").copy(device);
  const header = Buffer.alloc(4 + 36 + 32 + 4 + 4);
  header.writeUInt32BE(0x2714, 0);
  device.copy(header, 40);
  header.writeUInt32BE(counter, 72);
  header.writeUInt32BE(epp.length, 76);
  return Buffer.concat([header, epp]);
}

function sensor(raw: number, scale: number, offset: number): number | null {
  if (raw === 0 || raw === 0xff) return null;
  const value = raw * scale + offset;
  return value >= -40 && value <= 70 ? value : null;
}

function readWord(words: Buffer, word: number, shift: number, width: number): number {
  const offset = (word - 1) * 2;
  if (offset + 1 >= words.length) throw new ProtocolError("Status word is missing");
  const value = words.readUInt16BE(offset);
  return (value >> shift) & ((1 << width) - 1);
}

function setWord(words: Buffer, word: number, shift: number, width: number, value: number): void {
  if (value < 0 || value >= 1 << width) throw new ProtocolError("Control value is invalid");
  const offset = (word - 1) * 2;
  if (offset + 1 >= words.length) throw new ProtocolError("Control word is missing");
  const current = words.readUInt16BE(offset);
  const mask = ((1 << width) - 1) << shift;
  words.writeUInt16BE((current & ~mask) | ((value << shift) & mask), offset);
}

function parseStatus(blob: Buffer): AirConditionerState | null {
  if (blob[2] !== 0x27 || blob[3] !== 0x15) return null;
  if (EXTENDED46_STATUS_LENGTHS.has(blob.length)) return parseExtended46(blob);
  if (blob.length !== 125 && blob.length !== 127) return null;
  const words = blob.subarray(92, 92 + (blob.length === 127 ? 12 : 10));
  const modeCode = blob[94] >> 5;
  const mode: Record<number, HvacMode> = {
    0: "auto",
    1: "cool",
    2: "dry",
    4: "heat",
    6: "fan",
  };
  const fanCode = blob[94] & 0x07;
  const fan: Record<number, FanSpeed> = {
    1: "high",
    2: "medium",
    3: "low",
    5: "auto",
  };
  const indoorOffset = blob.length === 127 ? 104 : 102;
  const outdoorOffset = indoorOffset + 2;
  const ecoCode = readWord(words, 4, 3, 3);
  const eco: Record<number, EcoMode> = { 0: "off", 5: "l1", 6: "l2", 7: "l3" };
  return {
    power: Boolean(blob[97] & 0x01),
    targetTemperature: blob[92] + 16,
    currentTemperature: sensor(blob[indoorOffset], 0.5, 0),
    outdoorTemperature: sensor(blob[outdoorOffset], 1, -64),
    mode: mode[modeCode] || null,
    fan: fan[fanCode] || null,
    verticalSwing: Boolean(blob[93] & 0x08),
    horizontalSwing: Boolean(readWord(words, 4, 0, 3)),
    quiet: Boolean(readWord(words, 3, 4, 1)),
    eco: eco[ecoCode] || null,
  };
}

function reportField(blob: Buffer, word: number, shift: number, width: number): number {
  const offset = 92 + (word - 1) * 2;
  if (offset + 1 >= blob.length) throw new ProtocolError("Status word is missing");
  return (blob.readUInt16BE(offset) >> shift) & ((1 << width) - 1);
}

function parseExtended46(blob: Buffer): AirConditionerState {
  const modeCode = reportField(blob, 21, 13, 3);
  const modes: Record<number, HvacMode> = {
    0: "auto",
    1: "cool",
    2: "dry",
    4: "heat",
    6: "fan",
  };
  const ecoCode = reportField(blob, 30, 8, 8);
  const eco: Record<number, EcoMode> = { 0: "off", 1: "l1", 2: "l2", 3: "l3" };
  const fanCode = reportField(blob, 26, 8, 3);
  const fans: Partial<Record<number, FanSpeed>> = {
    0: "auto",
    2: "high",
    4: "medium",
    6: "low",
  };
  return {
    power: Boolean(reportField(blob, 22, 0, 1)),
    targetTemperature: reportField(blob, 20, 8, 8) * 0.5,
    currentTemperature: sensor(reportField(blob, 35, 8, 8), 0.5, 0),
    outdoorTemperature: sensor(reportField(blob, 36, 8, 8), 1, -64),
    mode: modes[modeCode] || null,
    fan: fans[fanCode] || null,
    verticalSwing: Boolean(reportField(blob, 25, 0, 4)),
    horizontalSwing: Boolean(reportField(blob, 26, 13, 3)),
    quiet: Boolean(reportField(blob, 22, 4, 1)),
    eco: eco[ecoCode] || null,
  };
}

function controlWords(statusBlob: Buffer, changes: ControlChanges, device: DeviceConfig): Buffer {
  if (EXTENDED46_STATUS_LENGTHS.has(statusBlob.length)) {
    if (device.uplusId !== EXTENDED46_UPLUS_ID) {
      throw new ProtocolError("This 209-byte layout is not a confirmed model match");
    }
    const words = Buffer.from(statusBlob.subarray(92 + 2 * 19, 92 + 2 * 30));
    if (changes.power !== undefined) setWord(words, 3, 0, 1, changes.power ? 1 : 0);
    if (changes.temperature !== undefined) {
      if (
        !Number.isInteger(changes.temperature) ||
        changes.temperature < 16 ||
        changes.temperature > 30
      ) {
        throw new ProtocolError("Temperature must be a whole number from 16 through 30");
      }
      setWord(words, 1, 8, 8, changes.temperature * 2);
    }
    if (changes.mode !== undefined) {
      const mode: Record<HvacMode, number> = {
        auto: 0,
        cool: 1,
        dry: 2,
        heat: 4,
        fan: 6,
      };
      setWord(words, 2, 13, 3, mode[changes.mode]);
    }
    if (changes.fan !== undefined) {
      const fan: Partial<Record<FanSpeed, number>> = {
        auto: 0,
        high: 2,
        medium: 4,
        low: 6,
      };
      const code = fan[changes.fan];
      if (code === undefined) {
        throw new ProtocolError("Unsupported fan speed");
      }
      setWord(words, 7, 8, 3, code);
    }
    if (changes.verticalSwing !== undefined)
      setWord(words, 6, 0, 4, changes.verticalSwing ? 0x0c : 0);
    if (changes.horizontalSwing !== undefined)
      setWord(words, 7, 13, 3, changes.horizontalSwing ? 0x07 : 0);
    if (changes.quiet !== undefined) setWord(words, 3, 4, 1, changes.quiet ? 1 : 0);
    if (changes.eco !== undefined) {
      const eco: Record<EcoMode, number> = { off: 0, l1: 1, l2: 2, l3: 3 };
      setWord(words, 11, 8, 8, eco[changes.eco]);
    }
    return words;
  }

  const wordCount = statusBlob.length === 127 ? 6 : statusBlob.length === 125 ? 5 : 0;
  if (!wordCount) throw new ProtocolError("This AC status layout is not safe to control");
  const words = Buffer.from(statusBlob.subarray(92, 92 + wordCount * 2));
  if (changes.power !== undefined) setWord(words, 3, 0, 1, changes.power ? 1 : 0);
  if (changes.temperature !== undefined) {
    if (
      !Number.isInteger(changes.temperature) ||
      changes.temperature < 16 ||
      changes.temperature > 30
    ) {
      throw new ProtocolError("Temperature must be a whole number from 16 through 30");
    }
    setWord(words, 1, 8, 8, changes.temperature - 16);
  }
  if (changes.mode !== undefined) {
    const mode: Record<HvacMode, number> = {
      auto: 0,
      cool: 1,
      dry: 2,
      heat: 4,
      fan: 6,
    };
    setWord(words, 2, 13, 3, mode[changes.mode]);
  }
  if (changes.fan !== undefined) {
    const fan: Record<FanSpeed, number> = {
      high: 1,
      medium: 2,
      low: 3,
      auto: 5,
    };
    setWord(words, 2, 8, 3, fan[changes.fan]);
  }
  if (changes.verticalSwing !== undefined) {
    setWord(words, 1, 0, 4, changes.verticalSwing ? 0x0c : 0);
  }
  if (changes.horizontalSwing !== undefined) {
    setWord(words, 4, 0, 3, changes.horizontalSwing ? 0x07 : 0);
  }
  if (changes.quiet !== undefined) setWord(words, 3, 4, 1, changes.quiet ? 1 : 0);
  if (changes.eco !== undefined) {
    const eco: Record<EcoMode, number> = { off: 0, l1: 5, l2: 6, l3: 7 };
    setWord(words, 4, 3, 3, eco[changes.eco]);
  }
  return words;
}

async function connect(host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: USS_PORT });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new ReadTimeout("Timed out connecting to AC"));
    }, 4000);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

function send(socket: Socket, data: Buffer): void {
  socket.write(data);
}

async function handshake(
  device: DeviceConfig,
  openSocket = connect,
): Promise<{
  socket: Socket;
  reader: SocketReader;
  session: number;
}> {
  const socket = await openSocket(device.host);
  const reader = new SocketReader(socket);
  try {
    send(socket, helloMessage(device.deviceId));
    const response = await reader.next(4000);
    if (response.infoType !== HELLO_RESPONSE)
      throw new ProtocolError("AC returned an unexpected handshake response");
    if (response.payload.length < 8 || response.payload.readUInt32BE(0) !== 1)
      throw new ProtocolError("AC rejected the handshake");
    const deviceKeyVersion = response.payload.readUInt32BE(4);
    if (deviceKeyVersion !== device.localKeyVersion) {
      throw new LocalKeyVersionMismatchError(deviceKeyVersion, device.localKeyVersion);
    }
    send(socket, helloDoneMessage(response.session));
    return { socket, reader, session: response.session };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function collectBlobs(
  reader: SocketReader,
  localKey: string,
  firstTimeout = 3500,
): Promise<Buffer[]> {
  const blobs: Buffer[] = [];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && blobs.length < 128) {
    try {
      const message = await reader.next(
        Math.min(deadline - Date.now(), blobs.length === 0 ? firstTimeout : COLLECT_IDLE_MS),
      );
      if (message.flag !== BIZ_FLAG || message.payload.length < 48) continue;
      try {
        blobs.push(decryptBiz(message.payload, localKey).data);
      } catch {
        continue;
      }
    } catch (error) {
      if (error instanceof ReadTimeout) return blobs;
      // A clean EOF completes collection. Keep fully decoded replies, but do
      // not hide a truncated frame or a transport error such as ECONNRESET.
      if (error instanceof ConnectionClosed && !reader.hasBufferedData) return blobs;
      throw error;
    }
  }
  return blobs;
}

function latestState(blobs: Buffer[]): { state: AirConditionerState; blob: Buffer } {
  for (const blob of [...blobs].reverse()) {
    const state = parseStatus(blob);
    if (state) return { state, blob };
  }
  throw new ProtocolError(
    "AC did not return a supported status report (payload lengths: " +
      blobs.map((blob) => blob.length).join(", ") +
      ")",
  );
}

export async function readDeviceStatus(
  device: DeviceConfig,
  openSocket = connect,
): Promise<AirConditionerState> {
  const { socket, reader } = await handshake(device, openSocket);
  try {
    return latestState(await collectBlobs(reader, device.localKey)).state;
  } finally {
    socket.destroy();
  }
}

export function resolvedControlChanges(
  baseline: AirConditionerState,
  changes: ControlChanges,
  settings: BridgeSettings = DEFAULT_SETTINGS,
): ControlChanges {
  let resolved =
    changes.power === true && !baseline.power
      ? { ...settings.startup, ...changes }
      : { ...changes };
  if (settings.linkQuietEco && resolved.quiet !== undefined && changes.eco === undefined) {
    resolved = { ...resolved, eco: resolved.quiet ? "off" : "l3" };
  }
  return resolved;
}

export async function controlDevice(
  device: DeviceConfig,
  changes: ControlChanges,
  settings: BridgeSettings = DEFAULT_SETTINGS,
  openSocket = connect,
): Promise<AirConditionerState> {
  const { socket, reader, session } = await handshake(device, openSocket);
  let needsFollowUpStatusRead = false;
  try {
    let sequenceBase: number | null = null;
    const earlyBlobs: Buffer[] = [];
    const sequenceDeadline = Date.now() + 6000;
    while (sequenceBase === null) {
      if (Date.now() >= sequenceDeadline || earlyBlobs.length >= 128)
        throw new ReadTimeout("AC control handshake timed out");
      const message = await reader.next(Math.min(4000, sequenceDeadline - Date.now()));
      if (message.infoType === HELLO_DONE_RESPONSE) {
        const decoded = decryptBiz(message.payload, device.localKey);
        if (decoded.data.length < 4) throw new ProtocolError("AC omitted control sequence");
        sequenceBase = decoded.data.readUInt32BE(0);
      } else if (message.flag === BIZ_FLAG && message.payload.length >= 48) {
        try {
          earlyBlobs.push(decryptBiz(message.payload, device.localKey).data);
        } catch {
          continue;
        }
      }
    }
    const baseline = latestState([...earlyBlobs, ...(await collectBlobs(reader, device.localKey))]);
    const epp = buildEpp(
      Buffer.from([0x60, 0x01]),
      controlWords(
        baseline.blob,
        resolvedControlChanges(baseline.state, changes, settings),
        device,
      ),
    );
    const request = buildControlRequest(epp, device.deviceId, 1);
    send(
      socket,
      encodeMessage(0x64, 0, encryptBiz(sequenceBase, request, device.localKey), BIZ_FLAG, session),
    );
    const responseBlobs = await collectBlobs(reader, device.localKey);
    const response = responseBlobs
      .slice()
      .reverse()
      .map((blob) => parseStatus(blob))
      .find((state): state is AirConditionerState => state !== null);
    if (response) return response;

    // Some models acknowledge a control request with a compact report rather
    // than a complete status frame. Confirm the applied change on a fresh
    // connection instead of reporting a successful command as an error.
    needsFollowUpStatusRead = true;
  } finally {
    socket.destroy();
  }

  if (needsFollowUpStatusRead) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    return readDeviceStatus(device, openSocket);
  }

  throw new ProtocolError("AC control request did not return a status report");
}
