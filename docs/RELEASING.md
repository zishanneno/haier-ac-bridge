# Releasing on GitHub

This guide is for maintainers publishing releases of `zishanneno/haier-ac-bridge` on GitHub and container images to GitHub Container Registry (GHCR).

1. Review the source changes, license, and release notes.
2. Enable GitHub Actions and private vulnerability reporting. Ensure repository Actions permissions permit the release workflow's `packages: write` permission.
3. Set the same numeric version in `package.json` and `compose.yaml`, and update `CHANGELOG.md`.
4. Install dependencies, then run `pnpm format:check`, `pnpm check`, `pnpm test`, `pnpm test:launchers`, and `pnpm build`. Validate the intended tag using the commands below. Build the Docker image and verify startup with an empty volume under the supplied read-only configuration.
5. Complete a real-device check: fresh wizard login, discovery/manual IP fallback, initial key retrieval, read-only status, selected controls, restart persistence, and reauthentication. Record model/firmware information. Synthetic tests cannot replace this step.
6. Commit the release candidate, push it to `main`, and wait for all CI checks, including Node 22/24 on Linux, Windows, and macOS. Export a local source archive from that commit and extract it into a new folder without dependencies, build output, or saved data. Follow the CLI quick start with only its documented prerequisites. Verify a fresh dependency installation without Python or C/C++ build tools; SQLite should use its bundled binary. On Windows and macOS, also test the desktop launcher, browser opening, access-code entry, a custom port, restart persistence, and interactive Ctrl+C. Automated launcher tests disable browser opening and use process-tree termination on Windows, so these manual checks are required **before pushing the release tag**. If files change, commit and repeat the affected checks against the new candidate.
7. Create the `vMAJOR.MINOR.PATCH` Git tag on the exact tested commit and push that tag. The release workflow first runs CI, validates the version, then builds and publishes numeric-version images for amd64 and arm64 to GHCR. It does not create a GitHub release or deploy anywhere.
8. After image publication succeeds, set the first GHCR package's visibility to **Public** and verify an anonymous pull of the exact numeric version tag. GitHub packages can initially be private even when the repository is public. Test the published image with an empty volume and verify that the source archive for the tag matches the tested candidate before announcing the release.
9. Create the GitHub release after all checks and image verification succeed. Lead its instructions with the CLI quick start, prerequisites, and compatibility limits. GitHub supplies source archives containing both Node.js desktop launchers; they require the full source folder. Optionally attach `compose.yaml` for users choosing Docker deployment.

Keep published version tags immutable; fixes receive a new version. No moving `latest` image is published.

## Validate the intended tag

For version `0.1.0`, run this from the repo folder on macOS/Linux:

```sh
RELEASE_TAG=v0.1.0 node scripts/check-release.mjs
```

In Windows PowerShell:

```powershell
$env:RELEASE_TAG = "v0.1.0"
node scripts/check-release.mjs
```

Adjust the version for later releases. This command checks the tag against `package.json` and `compose.yaml`; it does not create or push a tag.

## Export the candidate for manual testing

After committing the candidate, run this from the repo folder:

```sh
git archive --format=zip --prefix=haier-ac-bridge/ --output=../haier-ac-bridge-source.zip HEAD
```

Extract the archive into a new folder. It contains the committed source, so commit any intended changes before exporting it. Keep test data and credentials out of the release archive.

The workflow uses GitHub's automatic `GITHUB_TOKEN`; no personal access token or registry password is required. Actions are pinned to resolved commit SHAs and Dependabot is configured to propose updates.

References: [publishing images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images), [GHCR visibility and anonymous pulls](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
