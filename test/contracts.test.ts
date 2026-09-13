import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("OpenAPI has valid internal references and documents public setup routes", () => {
  const spec = parse(read("openapi.yaml"));
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.info.version, "__PACKAGE_VERSION__");
  function walk(value: unknown) {
    if (!value || typeof value !== "object") return;
    if ("$ref" in value && typeof value.$ref === "string") {
      assert.ok(value.$ref.startsWith("#/"));
      let target: any = spec;
      for (const part of value.$ref.slice(2).split("/")) target = target?.[part];
      assert.ok(target, "Missing schema reference: " + value.$ref);
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(spec);
  for (const path of [
    "/v1/auth/login",
    "/v1/auth/logout",
    "/v1/setup",
    "/v1/token",
    "/v1/cloud/login",
    "/v1/cloud/devices",
    "/v1/cloud/session",
    "/v1/discovery",
    "/v1/settings",
    "/v1/devices",
    "/v1/devices/{id}",
    "/v1/devices/{id}/refresh-key",
  ])
    assert.ok(spec.paths[path], path);
  assert.ok(!spec.components.parameters.DeviceId.schema.enum);
  assert.equal(spec.components.schemas.DeviceInput.properties.localKey.writeOnly, true);
});

test("Compose version matches the package and preserves safe runtime defaults", () => {
  const version = JSON.parse(read("package.json")).version,
    compose = parse(read("compose.yaml"));
  assert.equal(compose.services.bridge.image, "ghcr.io/zishanneno/haier-ac-bridge:" + version);
  assert.ok(compose.services.bridge.volumes.includes("bridge-data:/app/data"));
  assert.equal(compose.services.bridge.read_only, true);
  assert.ok(compose.services.bridge.ports[0].includes("127.0.0.1"));
  assert.equal(parse(read("compose.build.yaml")).services.bridge.build, ".");
});

test("workflow YAML parses, actions are pinned, and release requires passing checks", () => {
  // Docker build copies only the application/test context; workflow files are intentionally excluded.
  if (!existsSync(join(root, ".github/workflows"))) return;
  for (const file of readdirSync(join(root, ".github/workflows"))) {
    const workflow = parse(read(".github/workflows/" + file));
    assert.ok(workflow.on && workflow.jobs);
    for (const job of Object.values(workflow.jobs) as any[]) {
      for (const step of job.steps ?? [])
        if (step.uses && !step.uses.startsWith("./")) assert.match(step.uses, /@[a-f0-9]{40}$/);
    }
  }
  const release = parse(read(".github/workflows/release.yml"));
  assert.equal(release.jobs.publish.needs, "checks");
  assert.deepEqual(release.on.push.tags, ["v*"]);
});
