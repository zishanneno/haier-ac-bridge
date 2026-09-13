# Troubleshooting

Start with the [CLI quick start](../README.md#try-it-from-the-cli). Keep the terminal open while using the bridge; its startup output contains the browser address and bridge access code.

## Running from the CLI

| What you see                                                                 | What to do                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git`, `node`, or `pnpm` not found                                           | Install Git and Node.js 22 or 24. With Node installed, run `npm install --global pnpm@10.34.1` to install the expected package manager.                            |
| Missing dependencies or `tsx` not found                                      | Run `pnpm install --frozen-lockfile` in the repo folder, then `pnpm dev`.                                                                                          |
| Installation fails with `node-gyp`, missing Python, `make`, or Visual Studio | Use the pinned pnpm version and retry as described in [Dependency installation](#dependency-installation).                                                         |
| `dist/server.js` not found after `pnpm start`                                | Use `pnpm dev` to run directly from source. For the compiled app, run `pnpm build` before `pnpm start`.                                                            |
| Port already in use / `EADDRINUSE`                                           | Set `PORT=8788` in the repo's `.env` file, restart, and open localhost:8788.                                                                                       |
| Browser cannot connect                                                       | Check the terminal for startup errors and confirm the process is still running. Use the printed address. Other devices need LAN binding and the computer's LAN IP. |
| Bridge stopped when the terminal closed                                      | Keep the terminal open during your trial. For continuous use, run it under a process manager or use the optional Docker deployment.                                |
| Native SQLite/glibc error on Linux                                           | Check [Supported computers](#supported-computers). An older NAS/Linux runtime may need the optional Docker image.                                                  |
| Saved setup is missing                                                       | Confirm you are using the same repo folder and `DATA_DIR`. The default is the repo's `data/` directory. Restore the entire stopped-directory backup if needed.     |

### Dependency installation

Use `pnpm` from the quick start, rather than `npm install` inside the project. The repository tells pnpm to use SQLite's bundled binary, so a normal installation doesn't need Python, a compiler, or a separate SQLite installation.

If you see a `node-gyp` or missing-Python error, check that you have the current source and retry with the pinned package manager:

```sh
npm install --global pnpm@10.34.1
pnpm install --frozen-lockfile
pnpm dev
```

Keep your `data/` folder; it contains your saved setup. If installation still fails, share the error along with your operating system and the output of `node --version` and `pnpm --version` in an issue.

### Supported computers

Use Node.js 22 or 24 on macOS, Windows, or Linux with an **x64 or ARM64** processor. The SQLite package includes binaries for these platforms, including glibc and musl Linux. Older operating systems and NAS runtimes may not be compatible with those binaries. A 32-bit OS or Node.js installation is outside the standard setup path.

For a Linux library-version error, use a newer supported OS/runtime or the optional [Docker image](DOCKER.md#install-a-prebuilt-image). Installing compilers is not part of normal setup. Developers targeting another platform can investigate a source build separately.

### Desktop launchers

Install Node.js and pnpm as described in the quick start, then keep the launcher inside the full source folder. It installs dependencies and opens the browser automatically.

- If macOS reports a permission error after extracting an archive, run `chmod +x Start-mac.command` from the source folder.
- If your OS blocks the downloaded launcher, use the CLI quick start.
- If the browser doesn't open, use the address printed in the terminal.
- To skip opening a browser automatically, set `HAIER_OPEN_BROWSER=0` in `.env`.

Keep the terminal window open. Press **Ctrl+C** to stop the bridge; open the launcher again to restart.

## Setup and AC controls

| What you see                            | What to do                                                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access code rejected                    | Copy the Bridge access code from the current terminal output (or Docker startup log). It is not your Haismart password or API token. After several failed attempts wait one minute. |
| Haismart sign-in fails                  | Check the same email/phone, password, and country used in the Haismart app. Apple-only login needs a Haismart password. Accounts outside the supported service may not work.        |
| No ACs found on the network             | Check guest Wi-Fi/client isolation and firewall settings. Use the AC's IP from your router; Find AC at this address makes a direct UDP probe. Docker can also block broadcasts.     |
| Device appears but has no local address | Enter its local IP beside the account device. Cloud device listing does not reliably supply LAN addresses.                                                                          |
| AC connection times out                 | Check its power, IP, Wi-Fi network, firewall, and client isolation. Reserve its IP in the router. Control uses TCP 56800.                                                           |
| No local key / session expired          | Sign in again under Add AC, then Refresh key on the card. Local controls work without the cloud while the saved key remains valid.                                                  |
| Unsupported status/model layout         | Your model may use a different protocol. File a compatibility report; do not force another model identifier.                                                                        |

The UI reads status when you open/refresh the AC list or send a control. It does not continuously poll; press Refresh after changing an AC in another app.

## Optional Docker deployment

| What you see                                       | What to do                                                                                                                                                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The image cannot be downloaded                     | Verify that the version has been published and the GHCR package is public. You can use the CLI while waiting, or build an image with the Docker guide.                                                                                             |
| Port is already allocated / address already in use | Stop the CLI instance with Ctrl+C, or set `BRIDGE_PORT=8788` in `.env` beside `compose.yaml` and rerun `docker compose up --wait --wait-timeout 90`. Open localhost:8788 if you changed the port. `PORT` changes only the direct Node.js instance. |
| A new container has none of the CLI's saved ACs    | CLI and Docker use separate data locations. See Moving from a CLI trial in the Docker guide.                                                                                                                                                       |
| Settings disappeared after reinstall               | Check that the same persistent volume and Compose project name are in use. Restore your stopped-volume backup if needed.                                                                                                                           |
| Permission denied in /app/data                     | Use the supplied named volume. Custom bind mounts must be writable by container UID/GID 10001.                                                                                                                                                     |

See the [Docker and NAS guide](DOCKER.md) for deployment details.

When sharing an error, remove the bridge code, API token, Haismart password/session, local keys, and personal device identifiers. Startup output contains the bridge access code.
