import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { commands41410, isModel41410, parse41410 } from "../src/protocol-41410.js";
import { controlDevice, readDeviceStatus, type ControlChanges } from "../src/protocol.js";
import { validateDevice } from "../src/devices.js";
import { parseDiscoveryReply } from "../src/discovery.js";

const captures: { power: boolean; hex: string }[] = JSON.parse(
  readFileSync(new URL("./fixtures/model-41410.json", import.meta.url), "utf8"),
);
const model = "00000000000000008080000000041410";
const device = {
  id: "test",
  name: "Test AC",
  host: "127.0.0.1",
  deviceId: "SYNTHETIC",
  uplusId: model,
  localKey: "0123456789abcdef0123456789abcdef",
  localKeyVersion: 1,
};

test("issue #8 ON/OFF/ON captures decode the model's fields", () => {
  for (const capture of captures) {
    assert.deepEqual(parse41410(Buffer.from(capture.hex, "hex")), {
      power: capture.power,
      targetTemperature: 20,
      currentTemperature: 29,
      outdoorTemperature: 61,
      mode: "cool",
      fan: "auto",
      verticalSwing: false,
      horizontalSwing: true,
      quiet: false,
      eco: null,
    });
  }
});

test("117-byte reports require correct framing, opcode, checksum, and temperature", () => {
  const original = Buffer.from(captures[0].hex, "hex");
  for (const offset of [0, 76, 80, 81, 82, 90, 91, 100, 116]) {
    const bad = Buffer.from(original);
    bad[offset] ^= 1;
    // Framing/opcode rejection must hold even when the checksum is valid.
    // The payload/checksum mutations separately exercise integrity validation.
    if (offset !== 100 && offset !== 116) checksum(bad);
    assert.equal(parse41410(bad), null, "offset " + offset);
  }
  for (const length of [0, 99, 116, 118, 125, 127, 209, 210]) {
    const wrongLength = Buffer.alloc(length);
    original.copy(wrongLength);
    assert.equal(parse41410(wrongLength), null);
  }
  const bad = Buffer.from(original);
  bad.writeUInt16BE(15, 114);
  checksum(bad);
  assert.equal(parse41410(bad), null);
});

test("model identity supports the decoded ID and discovery's ASCII hex encoding only", () => {
  const packet = Buffer.alloc(73);
  packet.write("Haier");
  packet.writeUInt32BE(0x684d, 5);
  packet.write("SYNTHETIC", 21);
  packet.write(model, 37);
  const found = parseDiscoveryReply(packet, "192.168.1.10")!;
  for (const id of [model, found.uplusId, found.uplusId.toUpperCase()]) {
    assert.ok(isModel41410(id));
    assert.ok(validateDevice({ ...device, host: found.host, uplusId: id }).uplusId);
  }
  for (const id of [undefined, "", "0".repeat(32), model + "0".repeat(32), "a".repeat(64)])
    assert.equal(isModel41410(id), false);
  for (const id of ["f".repeat(31), "f".repeat(33), "f".repeat(63), "g".repeat(32)]) {
    assert.throws(() => validateDevice({ ...device, host: found.host, uplusId: id }), /32 or 64/);
  }
});

test("model commands use the expected individual opcodes and two-byte values", () => {
  const cases: [ControlChanges, string, string][] = [
    [{ power: true }, "4d02", ""],
    [{ power: false }, "4d03", ""],
    [{ temperature: 16 }, "5d01", "0000"],
    [{ temperature: 30 }, "5d01", "000e"],
    [{ mode: "auto" }, "5d08", "0000"],
    [{ mode: "cool" }, "5d08", "0001"],
    [{ mode: "heat" }, "5d08", "0002"],
    [{ mode: "fan" }, "5d08", "0003"],
    [{ mode: "dry" }, "5d08", "0004"],
    [{ fan: "high" }, "5d07", "0000"],
    [{ fan: "medium" }, "5d07", "0001"],
    [{ fan: "low" }, "5d07", "0002"],
    [{ fan: "auto" }, "5d07", "0003"],
    [{ verticalSwing: true }, "4d22", "0001"],
    [{ verticalSwing: false }, "4d22", "0000"],
    [{ horizontalSwing: true }, "4d23", "0001"],
    [{ horizontalSwing: false }, "4d23", "0000"],
  ];
  for (const [changes, opcode, data] of cases) {
    const commands = commands41410(changes);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].opcode.toString("hex"), opcode);
    assert.equal(commands[0].data.toString("hex"), data);
  }
  for (const changes of [
    { quiet: true },
    { quiet: false },
    { eco: "off" },
    { eco: "l3" },
    { temperature: 15 },
    { temperature: 30.5 },
    { fan: "invalid" },
  ]) {
    assert.throws(() => commands41410(changes as ControlChanges));
  }
});

function checksum(blob: Buffer) {
  blob[116] = blob.subarray(82, 116).reduce((sum, byte) => (sum + byte) & 255, 0);
}

// Independent uSS peer: decode actual outbound encrypted packets and return
// captured reports. No real AC, account, or LAN traffic is used by these tests.
const aesKey = createHash("md5").update(device.localKey, "ascii").digest();
function encrypted(data: Buffer): Buffer {
  const head = Buffer.alloc(42);
  head.writeUInt16BE(40 + data.length);
  head.writeUInt32BE(1, 2);
  head.write("1234", 38);
  createHash("md5")
    .update(Buffer.concat([head.subarray(38), data]))
    .digest()
    .copy(head, 6);
  const plain = Buffer.concat([head, data, Buffer.alloc((16 - ((42 + data.length) % 16)) % 16)]);
  const cipher = createCipheriv("aes-128-cbc", aesKey, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}
function frame(type: number, payload: Buffer, flag = 0): Buffer {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(0xea60 + type);
  head.writeUInt16BE(payload.length + 10, 4);
  head[6] = 1;
  head[7] = flag;
  head.writeUInt16BE(7, 14);
  return Buffer.concat([head, payload]);
}
async function peer(
  t: TestContext,
  options: { ackOnly?: boolean; ignore?: boolean; initial?: Buffer } = {},
) {
  let current = Buffer.from(options.initial ?? Buffer.from(captures[1].hex, "hex"));
  const writes: string[] = [],
    sessions: number[] = [],
    sockets = new Set<Socket>();
  let connections = 0;
  const reports = () =>
    Buffer.concat([
      frame(0x64, encrypted(current), 1),
      frame(0x64, encrypted(Buffer.alloc(99)), 1), // compact non-state reply after live state
    ]);
  const server = createServer((socket) => {
    const connection = ++connections;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 6) {
        const length = 6 + buffer.readUInt16BE(4);
        if (buffer.length < length) return;
        const packet = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        const type = packet.readUInt32BE(0) - 0xea60;
        if (type === 0) {
          socket.write(frame(1, Buffer.from("0000000100000001", "hex")));
        } else if (type === 2) {
          socket.write(
            Buffer.concat([frame(3, encrypted(Buffer.from("00000001", "hex"))), reports()]),
          );
        } else if (type === 0x64) {
          const cipher = packet.subarray(16, packet.length - 5);
          const decipher = createDecipheriv("aes-128-cbc", aesKey, Buffer.alloc(16));
          decipher.setAutoPadding(false);
          const plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
          const end = plain.readUInt16BE(0) + 2;
          assert.deepEqual(
            plain.subarray(6, 22),
            createHash("md5").update(plain.subarray(38, end)).digest(),
          );
          assert.equal(
            plain.readUInt32BE(2),
            1,
            "each fresh connection uses its handshake sequence",
          );
          const request = plain.subarray(42, end);
          assert.equal(request.readUInt32BE(0), 0x2714);
          assert.equal(request.readUInt32BE(72), 1);
          const epp = request.subarray(80);
          assert.equal(request.readUInt32BE(76), epp.length);
          assert.equal(epp.readUInt16BE(0), 0xffff);
          assert.equal(epp[2] + 3, epp.length);
          assert.equal(
            epp.subarray(2, -1).reduce((s, b) => (s + b) & 255, 0),
            epp.at(-1),
          );
          writes.push(epp.toString("hex"));
          sessions.push(connection);
          const opcode = epp.readUInt16BE(10);
          if (!options.ignore) {
            const values: Record<number, number> = { 0x5d01: 114, 0x5d08: 102, 0x5d07: 104 };
            if (opcode === 0x4d02) current[109] |= 1;
            else if (opcode === 0x4d03) current[109] &= ~1;
            else if (values[opcode]) current.writeUInt16BE(epp.readUInt16BE(12), values[opcode]);
            else if (opcode === 0x4d22) current[107] = (current[107] & ~1) | epp.readUInt16BE(12);
            else if (opcode === 0x4d23)
              current[107] = (current[107] & ~2) | (epp.readUInt16BE(12) << 1);
            else assert.fail("Unexpected opcode " + opcode.toString(16));
            checksum(current);
          }
          socket.end(options.ackOnly ? frame(0x64, encrypted(Buffer.alloc(99)), 1) : reports());
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  return {
    writes,
    sessions,
    open: async () => {
      const socket = createConnection({ host: "127.0.0.1", port });
      await once(socket, "connect");
      return socket;
    },
  };
}

test("public status API ignores the compact frame and scopes support to the model", async (t) => {
  const ac = await peer(t);
  assert.equal((await readDeviceStatus(device, ac.open)).power, false);
  assert.equal(
    (await readDeviceStatus({ ...device, uplusId: Buffer.from(model).toString("hex") }, ac.open))
      .targetTemperature,
    20,
  );
  for (const uplusId of [undefined, "a".repeat(64)]) {
    await assert.rejects(readDeviceStatus({ ...device, uplusId }, ac.open), /supported status/);
    await assert.rejects(
      controlDevice({ ...device, uplusId }, { power: true }, undefined, ac.open),
      /supported status/,
    );
  }
  assert.equal(ac.writes.length, 0);
});

test("power writes use the exact model-specific EPP frames", async (t) => {
  const ac = await peer(t);
  assert.equal((await controlDevice(device, { power: true }, undefined, ac.open)).power, true);
  assert.equal((await controlDevice(device, { power: false }, undefined, ac.open)).power, false);
  assert.deepEqual(ac.writes, ["ffff0a000000000000014d025a", "ffff0a000000000000014d035b"]);
});

test("multiple controls apply startup preferences with fresh sessions and correct ordering", async (t) => {
  const ac = await peer(t);
  const state = await controlDevice(
    device,
    { power: true, temperature: 23, horizontalSwing: false },
    {
      startup: { mode: "heat", temperature: 25, fan: "low", verticalSwing: true },
      linkQuietEco: false,
    },
    ac.open,
  );
  assert.deepEqual(
    ac.writes.map((hex) => hex.slice(20, -2)),
    ["4d02", "5d080002", "5d010007", "5d070002", "4d220001", "4d230000"],
  );
  assert.equal(new Set(ac.sessions).size, ac.writes.length);
  assert.equal(state.power, true);
  assert.equal(state.targetTemperature, 23);
  assert.equal(state.mode, "heat");
  assert.equal(state.fan, "low");
  assert.equal(state.verticalSwing, true);
  assert.equal(state.horizontalSwing, false);
});

test("unsupported startup controls fail before any command is sent", async (t) => {
  const ac = await peer(t);
  await assert.rejects(
    controlDevice(
      device,
      { power: true },
      { startup: { quiet: false }, linkQuietEco: false },
      ac.open,
    ),
    /Quiet and Eco/,
  );
  await assert.rejects(
    controlDevice(device, { temperature: 30, eco: "off" }, undefined, ac.open),
    /Quiet and Eco/,
  );
  assert.equal(ac.writes.length, 0);
});

test("compact ACK triggers a fresh read without resending the command", async (t) => {
  const ac = await peer(t, { ackOnly: true });
  assert.equal(
    (await controlDevice(device, { temperature: 22 }, undefined, ac.open)).targetTemperature,
    22,
  );
  assert.deepEqual(ac.writes, ["ffff0c000000000000015d01000671"]);
});

test("an acknowledged but ignored write fails and does not send later commands", async (t) => {
  const ac = await peer(t, { ignore: true });
  await assert.rejects(
    controlDevice(device, { power: true, temperature: 22 }, undefined, ac.open),
    /did not confirm.*power/,
  );
  assert.equal(ac.writes.length, 1);
});
