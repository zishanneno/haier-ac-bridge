import type { AirConditionerState, ControlChanges } from "./protocol.js";
import { validateControls } from "./settings.js";

// Model-specific status fields and individual control commands.
// See docs/PROTOCOL-41410.md for protocol details and hardware verification limits.
const MODEL_ID = "00000000000000008080000000041410";
const WIRE_MODEL_ID = Buffer.from(MODEL_ID, "ascii").toString("hex");

export function isModel41410(id: string | undefined): boolean {
  return id?.toLowerCase() === MODEL_ID || id?.toLowerCase() === WIRE_MODEL_ID;
}

export function parse41410(blob: Buffer): AirConditionerState | null {
  if (
    blob.length !== 117 ||
    blob.readUInt32BE(0) !== 0x2715 ||
    blob.readUInt32BE(76) !== 37 ||
    blob[80] !== 0xff ||
    blob[81] !== 0xff ||
    blob[82] !== 34 ||
    blob[90] !== 0x6d ||
    blob[91] !== 0x01
  )
    return null;
  const checksum = blob.subarray(82, 116).reduce((sum, byte) => (sum + byte) & 0xff, 0);
  if (checksum !== blob[116]) return null;
  const word = (n: number) => blob.readUInt16BE(92 + (n - 1) * 2);
  const temperature = word(12) + 16;
  if (temperature < 16 || temperature > 30) return null;
  const modes: Partial<Record<number, AirConditionerState["mode"]>> = {
    0: "auto",
    1: "cool",
    2: "heat",
    3: "fan",
    4: "dry",
  };
  const fans: Partial<Record<number, AirConditionerState["fan"]>> = {
    0: "high",
    1: "medium",
    2: "low",
    3: "auto",
  };
  const sensor = (raw: number) => (raw > 0 && raw <= 70 ? raw : null);
  return {
    power: Boolean(word(9) & 1),
    targetTemperature: temperature,
    currentTemperature: sensor(word(1)),
    outdoorTemperature: sensor(word(2) & 0xff),
    mode: modes[word(6)] ?? null,
    fan: fans[word(7)] ?? null,
    verticalSwing: Boolean(word(8) & 1),
    horizontalSwing: Boolean(word(8) & 2),
    quiet: Boolean(word(10) & 4),
    // This model reports a single energy-saving flag, not the bridge's L1–L3 levels.
    eco: null,
  };
}

export interface Model41410Command {
  opcode: Buffer;
  data: Buffer;
  field: keyof AirConditionerState;
  expected: boolean | number | string;
}

export function commands41410(changes: ControlChanges): Model41410Command[] {
  validateControls({ ...changes });
  // Validate the whole request before sending anything, including startup preferences.
  if (changes.quiet !== undefined || changes.eco !== undefined) {
    throw new Error(
      "Quiet and Eco controls are not supported for this AC model; remove them from the request or power-on preferences",
    );
  }
  const commands: Model41410Command[] = [];
  const add = (
    opcode: number,
    field: Model41410Command["field"],
    expected: Model41410Command["expected"],
    value?: number,
  ) => {
    const data = Buffer.alloc(value === undefined ? 0 : 2);
    if (value !== undefined) data.writeUInt16BE(value);
    const code = Buffer.alloc(2);
    code.writeUInt16BE(opcode);
    commands.push({ opcode: code, data, field, expected });
  };
  if (changes.power === true) add(0x4d02, "power", true);
  // Mode can reset other settings: apply temperature/fan/swing afterwards.
  if (changes.mode !== undefined)
    add(0x5d08, "mode", changes.mode, { auto: 0, cool: 1, heat: 2, fan: 3, dry: 4 }[changes.mode]);
  if (changes.temperature !== undefined)
    add(0x5d01, "targetTemperature", changes.temperature, changes.temperature - 16);
  if (changes.fan !== undefined)
    add(0x5d07, "fan", changes.fan, { high: 0, medium: 1, low: 2, auto: 3 }[changes.fan]);
  if (changes.verticalSwing !== undefined)
    add(0x4d22, "verticalSwing", changes.verticalSwing, Number(changes.verticalSwing));
  if (changes.horizontalSwing !== undefined)
    add(0x4d23, "horizontalSwing", changes.horizontalSwing, Number(changes.horizontalSwing));
  if (changes.power === false) add(0x4d03, "power", false);
  return commands;
}
