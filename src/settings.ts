import type { ControlChanges } from "./protocol.js";

export interface BridgeSettings {
  startup: ControlChanges;
  linkQuietEco: boolean;
}
export const DEFAULT_SETTINGS: BridgeSettings = { startup: {}, linkQuietEco: false };

export function validateControls(
  payload: Record<string, unknown>,
  allowEmpty = false,
): ControlChanges {
  const result: Record<string, unknown> = {};
  const enums: Record<string, readonly string[]> = {
    mode: ["auto", "cool", "dry", "heat", "fan"],
    fan: ["auto", "low", "medium", "high"],
    eco: ["off", "l1", "l2", "l3"],
  };
  for (let [key, value] of Object.entries(payload)) {
    if (key === "mode" && value === "heating") value = "heat";
    if (key === "eco" && value === "close") value = "off";
    if (["power", "verticalSwing", "horizontalSwing", "quiet"].includes(key)) {
      if (typeof value !== "boolean") throw new Error(key + " must be true or false");
    } else if (key === "temperature") {
      if (!Number.isInteger(value) || Number(value) < 16 || Number(value) > 30) {
        throw new Error("Temperature must be a whole number from 16 through 30");
      }
    } else if (Object.hasOwn(enums, key)) {
      if (typeof value !== "string" || !enums[key].includes(value)) {
        throw new Error(key + " must be one of: " + enums[key].join(", "));
      }
    } else throw new Error("Unknown control setting: " + key);
    result[key] = value;
  }
  if (!allowEmpty && Object.keys(result).length === 0)
    throw new Error("Choose at least one setting to change");
  return result as ControlChanges;
}

export function validateSettings(payload: Record<string, unknown>): BridgeSettings {
  if (!payload.startup || typeof payload.startup !== "object" || Array.isArray(payload.startup)) {
    throw new Error("Startup settings must be an object");
  }
  if ("power" in payload.startup) throw new Error("Startup defaults cannot set power");
  if (typeof payload.linkQuietEco !== "boolean")
    throw new Error("linkQuietEco must be true or false");
  return {
    startup: validateControls(payload.startup as Record<string, unknown>, true),
    linkQuietEco: payload.linkQuietEco,
  };
}
