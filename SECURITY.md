# Security and privacy

The bridge is a local administration service. Every authenticated browser or API client can control every configured AC, change configuration, and reveal the API token. There are no separate user roles.

## Access

The web interface binds to loopback by default. Opening it to the LAN is an explicit installation choice. Browser requests use a random HttpOnly, SameSite=Strict session cookie that expires after 24 hours; restarting or locking the bridge invalidates the relevant sessions. Mutating browser requests must originate from the bridge's own host. The API also accepts a bearer token or `X-API-Key`.

The bridge code is randomly generated, stored in `data/access.json`, and printed in the startup log for initial access and recovery. Failed code logins are rate-limited. Anyone who can read the data volume or logs can administer the bridge. Keep both private.

HTTP is supported for local use and is not encrypted. For use beyond a trusted local computer/network, put an HTTPS reverse proxy or VPN in front of the bridge; do not expose port 8787 directly to the Internet. A reverse proxy must preserve the original Host and Origin, and should mark the session cookie Secure. Forwarded identity headers are not used for authentication or rate limiting.

To reset a compromised access code/API token: stop the bridge, remove only `access.json` from the data directory/volume, remove any `HAIER_API_TOKEN` environment override, then restart. New credentials are generated, all browser sessions expire, and integrations must be reconfigured. The AC database remains intact.

## Stored data

The SQLite database stores device identifiers, local addresses, keys, preferences, and the renewable Haismart session. A password submitted through the browser is used for sign-in and is not persisted. If you explicitly configure `HAISMART_PASSWORD` in the environment or `.env`, it remains there until you remove it. Disconnecting Haismart disables that fallback until restart; remove the environment credentials to disconnect permanently.

On POSIX systems, the data directory is owner-only and the access file/database use owner read/write permissions. Windows users should restrict the folder's ACL to their account. The container runs as a non-root user and Compose mounts its runtime filesystem read-only except for data and temporary files.

Backups contain secrets. Do not attach data directories, `.env`, startup logs with access codes, or raw cloud replies to public issues. The app-level identifiers in `haier-cloud.ts` identify the shared Haismart client protocol; they are not the maintainer's account credentials.

No project telemetry or third-party browser assets are loaded by the bridge. Haier receives the account login and requests needed for account/device setup and local-key retrieval. The AC's own cloud behavior is separate from this bridge.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** option in the repository Security tab when private vulnerability reporting is enabled. If it is unavailable, open a minimal issue requesting a private contact method without exploit details or secrets. Please allow the maintainer time to investigate before public disclosure.
