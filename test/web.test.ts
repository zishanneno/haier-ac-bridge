import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const script = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

// Small DOM boundary double: execute the complete browser script, capture its events
// and rendered markup, and supply only the DOM operations used by these regressions.
class Element {
  value = "";
  hidden = false;
  open = false;
  focused = false;
  disabled = false;
  textContent = "";
  innerHTML = "";
  dataset: Record<string, string> = {};
  elements: Record<string, Element> = {};
  children: Element[] = [];
  events: Record<string, (event: any) => unknown> = {};
  validityChecks = 0;
  addEventListener(type: string, handler: (event: any) => unknown) {
    this.events[type] = handler;
  }
  close() {
    this.open = false;
  }
  focus() {
    this.focused = true;
  }
  reportValidity() {
    this.validityChecks++;
    return this.value.length > 0;
  }
  replaceChildren() {
    this.children = [];
    this.innerHTML = "";
  }
  append(child: Element) {
    this.children.push(child);
  }
  querySelectorAll() {
    return this.children;
  }
}

async function page() {
  const nodes = new Map<string, Element>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector)!;
  };
  const requests: { path: string; payload: any }[] = [];
  const context = createContext({
    document: {
      querySelector: node,
      querySelectorAll: () => [],
      createElement: () => new Element(),
    },
    fetch: async (path: string, options: any) => {
      requests.push({ path, payload: options.body ? JSON.parse(options.body) : undefined });
      return { ok: true, json: async () => (path === "/v1/setup" ? { version: "0.1.0" } : []) };
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  const run = (code: string) => runInContext(code, context);
  run(script);
  await new Promise((resolve) => setImmediate(resolve));
  requests.length = 0;
  return { node, run, context, requests };
}

test("an expired edit request closes the modal and makes unlocking available", async () => {
  const { node, run, context } = await page();
  node("#edit-dialog").open = true;
  node("#api-token").textContent = "test-token";
  node("#access-code").focused = false;
  context.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: "Unlock the bridge" }),
  });
  await assert.rejects(run('api("/v1/devices/living", "PUT", {})'), /Unlock the bridge/);
  assert.equal(node("#edit-dialog").open, false);
  assert.equal(node("#application").hidden, true);
  assert.equal(node("#unlock").hidden, false);
  assert.equal(node("#access-code").focused, true);
  assert.equal(node("#api-token").textContent, "");
  assert.equal(node("#api-token").hidden, true);
});

test("address lookup rejects empty and whitespace-only IPs without scanning", async () => {
  const { node, requests } = await page();
  for (const value of ["", "   "]) {
    node("#manual-host").value = value;
    await node("#probe").events.click({ target: node("#probe") });
    assert.equal(requests.length, 0);
    assert.equal(node("#probe").disabled, false);
  }
  assert.equal(node("#manual-host").validityChecks, 2);
});

test("address lookup sends the trimmed IP and ignores replies for a changed address", async () => {
  const { node, context } = await page();
  let reply: (value: unknown) => void = () => {};
  context.fetch = async (_path: string, options: any) => {
    assert.deepEqual(JSON.parse(options.body), { host: "192.168.1.50" });
    return { ok: true, json: () => new Promise((resolve) => (reply = resolve)) };
  };
  node("#manual-host").value = " 192.168.1.50 ";
  const pending = node("#probe").events.click({ target: node("#probe") });
  await new Promise((resolve) => setImmediate(resolve));
  node("#manual-host").value = "192.168.1.51";
  reply([{ deviceId: "old-address-device", uplusId: "old-model" }]);
  await pending;
  assert.equal(node("#manual-device").value, "");
  assert.equal(node("#manual-model").value, "");
});

test("discovery preserves candidate drafts and only fills empty addresses", async () => {
  const { node, run, context } = await page();
  run('candidates = [{ deviceId: "AABB", name: "Bedroom" }]; renderCandidates();');
  const form = node("#candidates").children[0];
  form.elements.name = new Element();
  form.elements.name.value = 'Guest "room"';
  form.elements.host = new Element();
  form.elements.host.value = "192.168.1.99";
  context.fetch = async () => ({
    ok: true,
    json: async () => [{ deviceId: "aabb", host: "192.168.1.51" }],
  });
  await run("scan()");
  const updated = node("#candidates").children[0];
  assert.match(updated.innerHTML, /value="Guest &quot;room&quot;"/);
  assert.match(updated.innerHTML, /value="192\.168\.1\.99"/);
  updated.elements = form.elements;
  updated.elements.name.value = "";
  updated.elements.host.value = "";
  await run("scan()");
  const markup = node("#candidates").children[0].innerHTML;
  assert.match(markup, /name="name" value=""/);
  assert.match(markup, /value="192\.168\.1\.51"/);
});

test("refreshing an empty device list makes removed account devices addable again", async () => {
  const { node, run } = await page();
  run(`
    candidates = [{ deviceId: "AABB", name: "Living room" }];
    devices = [{ deviceId: "aabb" }];
    renderCandidates();
  `);
  assert.match(node("#candidates").children[0].innerHTML, /Already added/);
  await run("loadDevices()");
  const markup = node("#candidates").children[0].innerHTML;
  assert.doesNotMatch(markup, /Already added/);
  assert.match(markup, /Add this AC/);
});
