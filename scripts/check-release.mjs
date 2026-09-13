import { readFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version) || process.env.RELEASE_TAG !== "v" + version) {
  throw new Error("Release tag must be v followed by the exact package.json version");
}
if (
  !readFileSync(new URL("../compose.yaml", import.meta.url), "utf8").includes(
    "haier-ac-bridge:" + version + "\n",
  )
) {
  throw new Error("Update compose.yaml to the release version before tagging");
}
console.log("Validated release v" + version);
