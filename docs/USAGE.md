# Using your bridge

For your first AC, start with the [quick start](../README.md#try-it-from-the-cli). This guide covers everyday use, updates, phone access, and automations.

## Start and stop

Press **Ctrl+C** in the terminal to stop the bridge. Run `pnpm dev` in the same folder to start it again. Your setup is retained in `data/`; restarting ends browser sessions, so unlock again with the same access code.

For a normal run without the source watcher, compile once and start:

```sh
pnpm build
pnpm start
```

Repeat `pnpm build` after updating TypeScript source when using `pnpm start`. Both commands use the same saved configuration as `pnpm dev`.

### Use another port or access it from your phone

The default address is `127.0.0.1:8787`, accessible on the computer running the bridge. If that port is occupied, create a `.env` file in the repo folder with:

```text
PORT=8788
```

Restart the bridge and open `http://localhost:8788`.

To allow other devices on your trusted home network, add `HOST=0.0.0.0` to `.env` and restart. Open `http://YOUR-COMPUTER-IP:8787` from your phone, using your chosen port if you changed it. Your computer and the bridge process must remain running.

HTTP does not encrypt browser traffic. Use an HTTPS reverse proxy or VPN on shared/untrusted networks, and keep the bridge off the public Internet. See [security](../SECURITY.md) and [.env.example](../.env.example) for optional settings.

### Update and back up

Stop the bridge, review the [release notes](../CHANGELOG.md), and back up the entire `data/` folder before updating. From a clean Git checkout:

```sh
git pull --ff-only
pnpm install --frozen-lockfile
pnpm dev
```

If you use the compiled app, run `pnpm build` and `pnpm start` after installing dependencies instead. Keep your `data/` folder in place to retain setup. Backups contain credentials and local keys; keep them private.

## Everyday controls

Only settings you select change. **Refresh status** reads the AC again; the screen does not continuously poll. Refresh after using the physical remote or another app.

Turning an AC on preserves its previous settings by default. In **Settings → Power-on preferences**, choose optional defaults for temperature, mode, fan, swing, Quiet, and Eco. They apply only on an off-to-on transition. Explicit control values take priority. Quiet/Eco linking is optional and off by default.

If a local key rotates, the bridge uses its saved Haier session to fetch a replacement and retries once. If the session expires, sign in again from **Add AC**. **Refresh key** retrieves a new key manually. Disconnecting Haismart removes its session while retaining local keys.

## Connect automations and Home Assistant

Once you have verified your AC works, use the REST API to connect other software. Open `/docs` for interactive documentation; `/openapi.yaml` contains the specification. In **Settings → Connect other apps**, reveal your API token. It grants full administrative access, so keep it private.

Example commands for a macOS/Linux terminal:

```sh
export HAIER_TOKEN='your-api-token'
curl -H "Authorization: Bearer $HAIER_TOKEN" http://localhost:8787/v1/devices
curl -H "Authorization: Bearer $HAIER_TOKEN" http://localhost:8787/v1/devices/YOUR-DEVICE-ID/status
curl -X POST -H "Authorization: Bearer $HAIER_TOKEN" -H 'Content-Type: application/json' \
  http://localhost:8787/v1/devices/YOUR-DEVICE-ID/control \
  -d '{"temperature":23,"mode":"cool"}'
```

Use the device ID returned by `GET /v1/devices`. `X-API-Key` is also supported. Configuration and control require authentication; UI assets, documentation, health checks, and access-code login are public.

Home Assistant can reach a running bridge through its API, whether the bridge runs directly with Node.js or in Docker. From another machine/container, use the bridge host's reachable address rather than `localhost`. This repository does not yet include a Home Assistant integration or app (add-on), and starting Docker does not automatically create Home Assistant entities.
