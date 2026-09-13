"use strict";
const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
let devices = [],
  candidates = [],
  nearby = [],
  setup = {},
  currentSettings = { startup: {}, linkQuietEco: false };
let noticeTimer;
function notice(message, error = false) {
  const element = $("#notice");
  element.textContent = message;
  element.className = error ? "error" : "";
  element.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(
    () => {
      element.hidden = true;
    },
    error ? 14000 : 7000,
  );
}
async function api(path, method = "GET", payload) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: payload === undefined ? {} : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "/v1/auth/login") showUnlock();
    throw new Error(result.error || "Unable to complete the request");
  }
  return result;
}
async function busy(button, task, label = "Working…") {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await task();
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
function showUnlock() {
  $("#edit-dialog").close();
  $("#unlock").hidden = false;
  $("#application").hidden = true;
  $("#api-token").textContent = "";
  $("#api-token").hidden = true;
  $("#access-code").focus();
}
function view(name) {
  document.querySelectorAll(".view").forEach((element) => {
    element.hidden = element.id !== name;
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === name);
    button.setAttribute("aria-current", button.dataset.view === name ? "page" : "false");
  });
  if (name === "settings") void loadSettings().catch((error) => notice(error.message, true));
}
async function refreshSetup() {
  setup = await api("/v1/setup");
  $("#version").textContent = setup.version;
  $("#account-state").textContent = setup.cloudConnected
    ? "A saved Haismart session is available for local-key refresh."
    : "Haismart is not connected. Sign in from Add AC when you need local keys.";
  $("#cloud-status").textContent = setup.cloudConnected
    ? "A session is already saved. Load your account devices below, or sign in again to reconnect."
    : "";
  $("#cloud-logout").disabled = !setup.cloudConnected;
}
async function enter() {
  await refreshSetup();
  $("#unlock").hidden = true;
  $("#application").hidden = false;
  await loadDevices();
}
$("#unlock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  $("#unlock-error").textContent = "";
  await busy(
    button,
    async () => {
      try {
        await api("/v1/auth/login", "POST", { code: $("#access-code").value });
        $("#access-code").value = "";
        await enter();
      } catch (error) {
        $("#unlock-error").textContent = error.message;
      }
    },
    "Opening…",
  );
});
document
  .querySelectorAll("[data-view]")
  .forEach((button) => button.addEventListener("click", () => view(button.dataset.view)));
$("#lock").addEventListener("click", () =>
  busy($("#lock"), async () => {
    await api("/v1/auth/logout", "POST");
    showUnlock();
  }),
);

const choices = {
  mode: [
    ["auto", "Auto"],
    ["cool", "Cool"],
    ["dry", "Dry"],
    ["heat", "Heat"],
    ["fan", "Fan only"],
  ],
  fan: [
    ["auto", "Auto"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
  ],
  eco: [
    ["off", "Off"],
    ["l1", "Level 1"],
    ["l2", "Level 2"],
    ["l3", "Level 3"],
  ],
  verticalSwing: [
    ["true", "On"],
    ["false", "Off"],
  ],
  horizontalSwing: [
    ["true", "On"],
    ["false", "Off"],
  ],
  quiet: [
    ["true", "On"],
    ["false", "Off"],
  ],
  temperature: Array.from({ length: 15 }, (_, index) => [String(index + 16), index + 16 + " °C"]),
};
const labels = {
  temperature: "Temperature",
  mode: "Mode",
  fan: "Fan speed",
  eco: "Eco",
  verticalSwing: "Vertical swing",
  horizontalSwing: "Horizontal swing",
  quiet: "Quiet",
};
function selectField(key, value, prefix, preserve = false) {
  const id = prefix + "-" + key;
  return `<div><label for="${escapeHTML(id)}">${labels[key]}</label><select id="${escapeHTML(id)}" name="${key}">${preserve ? '<option value="">Keep previous setting</option>' : '<option value="">Unchanged</option>'}${choices[key].map(([code, title]) => `<option value="${code}" ${String(value) === code ? "selected" : ""}>${title}</option>`).join("")}</select></div>`;
}
function controlsFrom(form) {
  const result = {};
  for (const [key, value] of new FormData(form)) {
    if (!(key in choices) || value === "") continue;
    result[key] =
      key === "temperature"
        ? Number(value)
        : ["verticalSwing", "horizontalSwing", "quiet"].includes(key)
          ? value === "true"
          : value;
  }
  return result;
}
function cardShell(device) {
  const card = document.createElement("article");
  card.className = "device-card";
  card.innerHTML = `<div class="card-heading"><div><h2>${escapeHTML(device.name)}</h2><span class="device-host">${escapeHTML(device.host)}</span></div><span class="state-badge">Checking…</span></div><div class="card-body"><p class="muted">Reading this AC's status…</p></div><div class="card-actions"><button class="text-button" data-action="refresh">Refresh</button><button class="text-button" data-action="edit">Edit name / IP</button><button class="text-button" data-action="key">Refresh key</button><button class="text-button" data-action="remove">Remove</button></div>`;
  card
    .querySelector('[data-action="refresh"]')
    .addEventListener("click", (event) =>
      busy(event.target, () => readCard(card, device), "Checking…"),
    );
  card.querySelector('[data-action="edit"]').addEventListener("click", () => {
    const form = $("#edit-form");
    form.elements.id.value = device.id;
    form.elements.name.value = device.name;
    form.elements.host.value = device.host;
    $("#edit-dialog").showModal();
  });
  card.querySelector('[data-action="key"]').addEventListener("click", (event) =>
    busy(event.target, async () => {
      await api(`/v1/devices/${device.id}/refresh-key`, "POST", {});
      await readCard(card, device);
      notice("Local key refreshed.");
    }),
  );
  card.querySelector('[data-action="remove"]').addEventListener("click", (event) => {
    if (confirm(`Remove ${device.name} from this bridge? This does not remove it from Haismart.`))
      void busy(event.target, async () => {
        await api(`/v1/devices/${device.id}`, "DELETE");
        await loadDevices();
        notice("AC removed from this bridge.");
      });
  });
  return card;
}
function renderState(card, device, state) {
  const badge = card.querySelector(".state-badge");
  badge.textContent = state.power ? "ON · CONNECTED" : "OFF · CONNECTED";
  badge.className = "state-badge" + (state.power ? " on" : "");
  const body = card.querySelector(".card-body");
  body.innerHTML = `<p class="temperature-label">Target</p><div class="temperature">${escapeHTML(state.targetTemperature)}<small>°C</small></div><p class="status-detail">Current Temperature: ${state.currentTemperature === null ? "unavailable" : escapeHTML(state.currentTemperature) + " °C"}</p><button class="${state.power ? "secondary" : "primary"}" data-action="power">${state.power ? "Turn off" : "Turn on"}</button><form class="control-form"><div class="field-grid">${["temperature", "mode", "fan"].map((key) => selectField(key, undefined, device.id)).join("")}</div><details class="muted"><summary>More controls</summary><div class="field-grid">${["eco", "verticalSwing", "horizontalSwing", "quiet"].map((key) => selectField(key, undefined, device.id)).join("")}</div></details><div class="button-row"><button class="secondary" type="submit">Apply changes</button></div></form><p class="muted">${escapeHTML(state.mode || "Unknown mode")} · Fan ${escapeHTML(state.fan || "unknown")} · Eco ${escapeHTML(state.eco || "unknown")}</p>`;
  body.querySelector('[data-action="power"]').addEventListener("click", (event) =>
    busy(
      event.target,
      async () => {
        const result = await api(`/v1/devices/${device.id}/power`, "POST", { on: !state.power });
        renderState(card, device, result.state);
      },
      "Applying…",
    ),
  );
  body.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const changes = controlsFrom(event.target);
    if (!Object.keys(changes).length) {
      notice("Choose a setting to change first.");
      return;
    }
    void busy(
      event.submitter,
      async () => {
        const result = await api(`/v1/devices/${device.id}/control`, "POST", changes);
        renderState(card, device, result.state);
        notice("AC settings updated.");
      },
      "Applying…",
    );
  });
}
async function readCard(card, device) {
  try {
    const result = await api(`/v1/devices/${device.id}/status`);
    renderState(card, device, result.state);
  } catch (error) {
    card.querySelector(".state-badge").textContent = "NEEDS ATTENTION";
    card.querySelector(".state-badge").className = "state-badge";
    card.querySelector(".card-body").innerHTML =
      `<div class="device-error">${escapeHTML(error.message)}</div><p class="muted">Check the AC's power and IP address. Reconnect Haismart in Add AC if its session expired.</p>`;
  }
}
async function loadDevices() {
  devices = await api("/v1/devices");
  renderCandidates();
  const container = $("#devices");
  container.replaceChildren();
  $("#device-count").textContent = devices.length
    ? `${devices.length} air conditioner${devices.length === 1 ? "" : "s"} connected to your bridge.`
    : "Your air conditioners, all in one place.";
  if (!devices.length) {
    container.innerHTML =
      '<div class="empty-state"><div class="empty-icon" aria-hidden="true">≋</div><h2>Your home starts here.</h2><p>Add your first AC to see its temperature, change its settings, and make your space feel just right.</p><button id="first-ac" class="primary">Add my first AC →</button></div>';
    $("#first-ac").addEventListener("click", () => view("add"));
    return;
  }
  const cards = devices.map((device) => {
    const card = cardShell(device);
    container.append(card);
    return card;
  });
  for (let index = 0; index < devices.length; index += 4)
    await Promise.all(
      devices
        .slice(index, index + 4)
        .map((device, offset) => readCard(cards[index + offset], device)),
    );
}
$("#refresh").addEventListener("click", (event) => busy(event.target, loadDevices, "Refreshing…"));
$("#edit-close").addEventListener("click", () => $("#edit-dialog").close());
$("#edit-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void busy(event.submitter, async () => {
    const values = Object.fromEntries(new FormData(event.target));
    await api(`/v1/devices/${values.id}`, "PUT", { name: values.name, host: values.host });
    $("#edit-dialog").close();
    await loadDevices();
    notice("AC details saved.");
  });
});

async function loadCloud() {
  candidates = await api("/v1/cloud/devices");
  renderCandidates();
}
async function scan() {
  $("#scan-status").textContent = "Looking for ACs on your home network…";
  try {
    nearby = await api("/v1/discovery", "POST", {});
    $("#scan-status").textContent = nearby.length
      ? `Found ${nearby.length} device${nearby.length === 1 ? "" : "s"} nearby. Matched addresses are filled in below.`
      : "No devices found. Enter the AC's IP address below; discovery may be blocked by your network or Docker.";
    renderCandidates();
  } catch (error) {
    $("#scan-status").textContent = error.message;
  }
}
function deviceSlug(name, deviceId) {
  return (
    (name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "ac") +
    "-" +
    deviceId
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(-12)
  );
}
async function addDevice(payload) {
  payload.id = deviceSlug(payload.name, payload.deviceId);
  await api("/v1/devices", "POST", payload);
  view("home");
  await loadDevices();
  notice("AC saved. Its card shows whether the connection is working.");
}
function renderCandidates() {
  const container = $("#candidates");
  const drafts = new Map(
    Array.from(container.querySelectorAll("form"))
      .filter((form) => form.elements.name && form.elements.host)
      .map((form) => [
        form.dataset.deviceId,
        { name: form.elements.name.value, host: form.elements.host.value },
      ]),
  );
  container.replaceChildren();
  if (!candidates.length) {
    container.innerHTML =
      '<p class="empty-inline">No account devices to show. Pair your AC in Haismart, then load account devices. You can also use Add by IP or local key.</p>';
    return;
  }
  for (const candidate of candidates) {
    const form = document.createElement("form");
    form.className = "candidate";
    form.dataset.deviceId = candidate.deviceId.toLowerCase();
    const draft = drafts.get(form.dataset.deviceId);
    const match = nearby.find(
      (device) => device.deviceId.toLowerCase() === candidate.deviceId.toLowerCase(),
    );
    const saved = devices.some(
      (device) => device.deviceId.toLowerCase() === candidate.deviceId.toLowerCase(),
    );
    const id = "candidate-" + candidate.deviceId;
    form.innerHTML = `<h3>${escapeHTML(candidate.name)}</h3><small>${escapeHTML(candidate.model || candidate.deviceType || "Haier device")} · ${escapeHTML(candidate.deviceId)}</small>${saved ? '<p class="muted">Already added to your bridge.</p>' : `<label for="${escapeHTML(id)}-name">Room or AC name</label><input id="${escapeHTML(id)}-name" name="name" value="${escapeHTML(draft?.name ?? candidate.name)}" maxlength="80" required><label for="${escapeHTML(id)}-host">Local IP address</label><input id="${escapeHTML(id)}-host" name="host" value="${escapeHTML(draft?.host || match?.host || "")}" placeholder="192.168.1.50" required><div class="button-row"><button class="primary" type="submit">Add this AC</button></div>`}`;
    if (!saved)
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void busy(
          event.submitter,
          async () => {
            const values = Object.fromEntries(new FormData(form));
            await addDevice({
              ...values,
              deviceId: candidate.deviceId,
              uplusId: candidate.uplusId || match?.uplusId || "",
            });
          },
          "Adding…",
        );
      });
    container.append(form);
  }
}
$("#cloud-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void busy(
    event.submitter,
    async () => {
      const credentials = Object.fromEntries(new FormData(event.target));
      try {
        await api("/v1/cloud/login", "POST", credentials);
      } finally {
        $("#password").value = "";
        credentials.password = "";
      }
      await refreshSetup();
      await loadCloud();
      await scan();
      notice("Haismart connected. Choose the ACs you want to add.");
    },
    "Connecting…",
  );
});
$("#cloud-reload").addEventListener("click", (event) => busy(event.target, loadCloud, "Loading…"));
$("#scan").addEventListener("click", (event) => busy(event.target, scan, "Searching…"));
$("#probe").addEventListener("click", (event) =>
  busy(
    event.target,
    async () => {
      const address = $("#manual-host");
      address.value = address.value.trim();
      if (!address.reportValidity()) return;
      const host = address.value;
      const found = await api("/v1/discovery", "POST", { host });
      if (address.value.trim() !== host) return;
      if (!found.length)
        throw new Error(
          "No AC replied at that address. Check the IP in your router's connected-device list.",
        );
      $("#manual-device").value = found[0].deviceId;
      $("#manual-model").value = found[0].uplusId;
      notice("Found the device. Give it a name and add it below.");
    },
    "Looking…",
  ),
);
$("#manual-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void busy(
    event.submitter,
    async () => {
      const payload = Object.fromEntries(new FormData(event.target));
      payload.localKeyVersion = Number(payload.localKeyVersion);
      await addDevice(payload);
      event.target.reset();
    },
    "Adding…",
  );
});
function renderSettings() {
  $("#startup-fields").innerHTML = Object.keys(choices)
    .map((key) => selectField(key, currentSettings.startup[key], "startup", true))
    .join("");
  $("#settings-form").elements.linkQuietEco.checked = currentSettings.linkQuietEco;
}
async function loadSettings() {
  await refreshSetup();
  currentSettings = await api("/v1/settings");
  renderSettings();
}
$("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void busy(event.submitter, async () => {
    currentSettings = await api("/v1/settings", "PUT", {
      startup: controlsFrom(event.target),
      linkQuietEco: event.target.elements.linkQuietEco.checked,
    });
    notice("Power-on preferences saved.");
  });
});
$("#reset-defaults").addEventListener("click", (event) =>
  busy(event.target, async () => {
    currentSettings = await api("/v1/settings", "PUT", { startup: {}, linkQuietEco: false });
    renderSettings();
    notice("Power-on now preserves each AC's settings.");
  }),
);
$("#show-token").addEventListener("click", (event) =>
  busy(event.target, async () => {
    const result = await api("/v1/token");
    $("#api-token").textContent = result.token;
    $("#api-token").hidden = false;
  }),
);
$("#cloud-logout").addEventListener("click", (event) => {
  if (
    confirm(
      "Disconnect Haismart? Saved local keys remain, but key refresh will need you to sign in again.",
    )
  )
    void busy(event.target, async () => {
      await api("/v1/cloud/session", "DELETE");
      candidates = [];
      renderCandidates();
      await refreshSetup();
      notice("Haismart disconnected.");
    });
});
void enter().catch((error) => {
  showUnlock();
  if (!error.message.includes("Unlock the bridge")) $("#unlock-error").textContent = error.message;
});
