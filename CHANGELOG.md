# Changelog

## 0.1.1 — unreleased

- Add support for model `00000000000000008080000000041410`, reported in [#8](https://github.com/zishanneno/haier-ac-bridge/issues/8): decode 117-byte status reports and use model-specific power, temperature, mode, fan, and swing commands.
- Accept 32-character model identifiers alongside 64-character identifiers, and recognize this model's encoded discovery identifier.
- Confirm reported state after each model-specific command; handle compact acknowledgements without resending commands and report ignored writes as errors.
- Add capture-based and simulated-device regression tests. Real-device control verification remains pending; Quiet/Eco writes are unsupported for this model.

## 0.1.0 — first public release candidate

- Browser access-code login, guided Haismart sign-in, device selection, and LAN discovery.
- Add, rename, remove, and change addresses for any number of ACs without a private TypeScript file.
- Browser controls and configurable power-on preferences. Power-on now preserves prior AC settings by default; Quiet/Eco linking is opt-in.
- Persistent local keys, session, access credentials, and preferences in one data volume.
- CLI setup uses bundled SQLite binaries on supported platforms, without Python or compiler prerequisites.
- Docker/Compose packaging, desktop launch helpers, MIT license, public documentation, and GitHub checks/releases.
- Authentication, persistence, validation, discovery parsing, and API regression coverage.
