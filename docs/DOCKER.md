# Docker and NAS deployment

Start with the [CLI quick start](../README.md#try-it-from-the-cli) to connect and try your AC. Use this guide when you want to run the bridge continuously on a computer, server, or NAS for automations.

Docker is an optional way to host the same application. Home Assistant integration still uses the bridge's API; this repository does not yet ship a Home Assistant integration or app (add-on).

## Install a prebuilt image

Install Docker Desktop on Windows/macOS, or Docker with Compose on Linux/NAS. Download `compose.yaml` from the [release](https://github.com/zishanneno/haier-ac-bridge/releases) you want to run and keep it in a dedicated folder.

The image must have been published by the release workflow before these commands work. If it is unavailable, keep using the CLI or use the optional source build below.

If your CLI or desktop-launcher instance is running on this computer, press **Ctrl+C** in its terminal before starting Docker. Both use port `8787` by default. To keep both running, first choose a different Docker port as described below.

From the folder containing `compose.yaml`:

```sh
docker compose up --wait --wait-timeout 90
docker compose logs --tail 15 bridge
```

Wait for the container to become **Healthy**, then open [localhost:8787](http://localhost:8787) and enter the **Bridge access code** from its startup log. Follow the browser setup flow to connect your ACs.

The source archive's `Start-mac.command` and `Start-windows.cmd` launchers run directly with Node.js. To start a Docker deployment, use the Compose commands above.

### Choose a different Docker port

Create or edit `.env` beside `compose.yaml` and add:

```text
BRIDGE_PORT=8788
```

Run `docker compose up --wait --wait-timeout 90` to apply the setting, then open [localhost:8788](http://localhost:8788). This also works with the optional source build; rerun its full command with both Compose files.

| Run method                         | Port setting       | LAN access setting            | Where to set it              |
| ---------------------------------- | ------------------ | ----------------------------- | ---------------------------- |
| CLI or desktop launcher            | `PORT=8788`        | `HOST=0.0.0.0`                | `.env` in the source folder  |
| Supplied Docker Compose deployment | `BRIDGE_PORT=8788` | `BRIDGE_BIND_ADDRESS=0.0.0.0` | `.env` beside `compose.yaml` |

Compose uses `BRIDGE_PORT` for the host port and keeps port `8787` inside the container. The supplied Compose files do not pass the CLI's `PORT` or `HOST` settings into the container, even if they share the same `.env` file.

## Moving from a CLI trial

A new Docker deployment uses its own data volume and starts with an empty setup. It does not automatically import the CLI's `data/` folder. Stop the CLI with Ctrl+C and back up that folder before moving. The simplest transition is to add your ACs again through the Docker instance's browser wizard and use its API token in integrations.

If migrating the existing data instead, stop both instances and restore the **entire** CLI data directory into the Docker data volume using your volume-management tools. The files must be writable by container UID/GID `10001`. Copying the whole stopped directory preserves SQLite data and access credentials; never copy a live database piecemeal. Keep the original backup until you verify the new instance.

## Access from a NAS, phone, or Home Assistant

By default, Compose publishes the interface only on the computer running Docker. To make it reachable from other devices on your trusted LAN, create `.env` beside `compose.yaml`:

```text
BRIDGE_BIND_ADDRESS=0.0.0.0
# Optional if the default port is occupied:
# BRIDGE_PORT=8788
```

Run `docker compose up --wait --wait-timeout 90` again to apply the change. Visit `http://YOUR-BRIDGE-HOST-IP:8787`, using your chosen port if changed. On a NAS, import the Compose file into its container manager and read the access code from the container's **Logs** view. Keep `/app/data` mounted persistently.

For a Home Assistant instance on another machine or in another container, configure your API client/automation to use that reachable bridge address and the API token from **Settings → Connect other apps**. `localhost` inside Home Assistant refers to its own environment. Docker installation alone does not discover the bridge or create AC entities in Home Assistant.

HTTP is not encrypted. For shared/untrusted networks, use an HTTPS reverse proxy or VPN. Do not port-forward the bridge to the Internet. See [security](../SECURITY.md).

## Discovery and connectivity

Docker bridge networking and Docker Desktop may block LAN broadcast discovery. Enter the AC's IP beside its account device, or use **Add by IP or local key → Find AC at this address** for a direct probe. Control uses TCP `56800`; discovery uses UDP `7083`.

The host/container needs access to the AC's network. Avoid guest Wi-Fi/client isolation and reserve the AC's IP in your router if it changes frequently.

## Stop, update, and back up

- Stop: `docker compose stop`.
- Resume: `docker compose start`.
- Closing the browser or terminal does not stop the container. Docker itself and the host must remain running.

To update, review the release notes and back up the stopped data volume. Replace the Compose file with the new release's version, keeping the same project folder/name, then run:

```sh
docker compose pull
docker compose up --wait --wait-timeout 90
```

Images use explicit version tags. Device configuration, keys, preferences, the Haismart session, and access credentials live in the `bridge-data` named volume. Stop the bridge before backing up that entire volume with your NAS/Docker tools. Backups contain secrets.

`docker compose down` retains the volume. `docker compose down -v` deletes it and resets setup. A custom bind mount must be writable by UID/GID `10001`; the supplied named-volume configuration handles ownership on first creation.

## Optional: build your own image

For container development or before a prebuilt release exists, run from the full source checkout. Stop any CLI instance using the same host port first, or choose a different `BRIDGE_PORT`:

```sh
docker compose -f compose.yaml -f compose.build.yaml up --build --wait --wait-timeout 90
docker compose logs --tail 15 bridge
```

The image build runs type checks and tests before creating the runtime image. Normal first-use testing can use the CLI quick start without this step.
