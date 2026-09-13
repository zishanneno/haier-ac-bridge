import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

export function loadEnvironment(root: string): void {
  const file = join(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const [, name, raw] = match;
    process.env[name] =
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
        ? raw.slice(1, -1)
        : raw;
  }
}

export function loadAccess(root: string): {
  dataDirectory: string;
  apiToken: string;
  accessCode: string;
} {
  const dataDirectory = resolve(process.env.DATA_DIR || join(root, "data"));
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dataDirectory, 0o700);
  const file = join(dataDirectory, "access.json");
  if (!existsSync(file)) {
    writeFileSync(
      file,
      JSON.stringify({
        apiToken: randomBytes(32).toString("hex"),
        accessCode: randomBytes(8).toString("hex"),
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  }
  chmodSync(file, 0o600);
  const stored: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !stored ||
    typeof stored !== "object" ||
    !("apiToken" in stored) ||
    !("accessCode" in stored) ||
    typeof stored.apiToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(stored.apiToken) ||
    typeof stored.accessCode !== "string" ||
    !/^[a-f0-9]{16}$/.test(stored.accessCode)
  ) {
    throw new Error(
      "Invalid data/access.json. Restore it from a backup, or remove it while stopped to reset bridge access.",
    );
  }
  const apiToken = process.env.HAIER_API_TOKEN || stored.apiToken;
  if (apiToken.length < 24 || /[\r\n]/.test(apiToken))
    throw new Error("HAIER_API_TOKEN must contain at least 24 characters and no line breaks");
  return { dataDirectory, apiToken, accessCode: stored.accessCode };
}
