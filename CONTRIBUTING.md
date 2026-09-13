# Contributing

For first-use setup, follow the [CLI quick start](README.md#try-it-from-the-cli). The checks below are for development and pull requests.

Use Node.js 22 or 24 and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:launchers
pnpm build
pnpm dev
```

The tests use temporary databases and fake cloud/device transports. They do not sign in to a real account, scan your LAN, or change real AC settings. Validate browser changes with an empty data directory and synthetic devices before testing your own hardware. Test desktop and phone layouts, keyboard navigation, error states, and refresh/restart behavior.

CI tests Node 22/24 on Linux, Windows, and macOS. The launcher smoke test starts from a temporary source folder with no installed dependencies, build output, or saved data. It runs the native desktop wrapper on Windows/macOS and the shared Node launcher on Linux, verifies a custom port and restart persistence, and checks that shutdown releases the port. It installs dependencies and requires Internet access. It disables dependency build caching and sets an invalid Python executable to catch accidental SQLite source builds. SQLite uses its bundled binaries via the pnpm settings in `package.json`; keep that installation path working when updating dependencies. Browser opening is disabled for CI; verify browser opening and interactive Ctrl+C manually on each desktop OS. Automated shutdown sends Ctrl+C on macOS/Linux and terminates the process tree on Windows.

For Docker changes, build the image and verify a fresh persistent volume under the read-only Compose configuration. CI also builds and starts a Linux container. Release builds target linux/amd64 and linux/arm64.

Dependabot keeps the Docker image on its current Node.js major version. Review runtime major upgrades separately, updating package-manager installation and the CI matrix together. Node 26's image does not include the Corepack command used by the current Dockerfile.

npm version updates have a three-day cooldown. If Dependabot reports `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, a dependency is still inside that waiting period. Retry the update after the named version is at least 72 hours old; keep the release-age protection enabled. This can affect updates to other packages when pnpm resolves the shared lockfile.

Keep credentials, local configuration, databases, and packet captures out of Git. Sanitized captures must replace all account IDs, local keys, session tokens, device IDs, and network addresses. See SECURITY.md.

For a new AC model, include its retail model, Haismart region, firmware, read-only status layout, and the exact controls verified. Unknown layouts must fail clearly instead of guessing write offsets. Do not remove the extended-layout model check to force support.

Please describe the user-visible behavior changed and how it was tested. Add regression tests for protocol, authentication, persistence, and API changes. Update the OpenAPI document and user instructions when their contracts change.
