import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeDatabase } from "./database.js";
import { HaierKeyRefresher } from "./haier-cloud.js";
import { BridgeAuth } from "./auth.js";
import { loadEnvironment, loadAccess } from "./config.js";
import { createApp } from "./app.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
loadEnvironment(root);
const access = loadAccess(root);
const db = new BridgeDatabase(join(access.dataDirectory, "haier-ac-bridge.sqlite"));
const cloud = new HaierKeyRefresher(
  db,
  process.env.HAISMART_USERNAME && process.env.HAISMART_PASSWORD
    ? {
        username: process.env.HAISMART_USERNAME,
        password: process.env.HAISMART_PASSWORD,
        zoneInfo: process.env.HAISMART_ZONE || "0",
      }
    : null,
);
const version: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const port = Number(process.env.PORT || 8787),
  host = process.env.HOST || "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be a number from 1 to 65535");
export const server = createApp({
  root,
  version,
  database: db,
  cloud,
  auth: new BridgeAuth(access.apiToken, access.accessCode),
});
server.listen(port, host, () => {
  console.log(
    "Haier AC Bridge " +
      version +
      " is ready at http://" +
      (host === "0.0.0.0" ? "localhost" : host) +
      ":" +
      port,
  );
  console.log("Bridge access code: " + access.accessCode.match(/.{4}/g)!.join("-"));
  console.log("Keep this code private. Enter it in the browser to unlock the bridge.");
});
function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
