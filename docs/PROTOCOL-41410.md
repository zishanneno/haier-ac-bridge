# Haismart model 41410

This model was reported in [issue #8](https://github.com/zishanneno/haier-ac-bridge/issues/8), using the Southeast Asia service in Pakistan. Account sign-in, local-key retrieval, and the local handshake already worked, but the bridge rejected its shorter status reports.

The model ID is `00000000000000008080000000041410`. LAN discovery may return the hexadecimal encoding of that 32-character ASCII identifier instead. The bridge recognizes both exact representations. Other unknown 117-byte models remain unsupported.

## Evidence and implementation

The issue includes three 117-byte ON/OFF/ON captures with valid EPP checksums. They are retained in `test/fixtures/model-41410.json`. The trailing 99-byte reply described by the reporter is not treated as live state; the reporter did not supply its bytes, so tests use a synthetic compact reply.

Reports use opcode `6d01` and twelve big-endian 16-bit words starting at byte 92. Power is word 9, bit 0 (absolute byte 109). Target temperature is word 12 plus 16 °C. Current temperature is word 1. Outdoor temperature is the low byte of word 2, decoded with scale 1 and offset 0; sensor readings outside the supported range are unavailable. Mode and fan occupy words 6 and 7. Vertical/horizontal swing are word 8, bits 0/1; Quiet is word 10, bit 2.

The captured reports decode as target 20 °C, current 29 °C, outdoor 61 °C, cooling, automatic fan, vertical swing off and horizontal swing on. Only power transitions were independently confirmed by the reporter. Temperature units/scaling and the other fields still need comparison against the real device and Haismart UI.

| Setting                     | Command         | Data                                                 |
| --------------------------- | --------------- | ---------------------------------------------------- |
| Power on / off              | `4d02` / `4d03` | None                                                 |
| Temperature                 | `5d01`          | Two-byte value: °C minus 16                          |
| Mode                        | `5d08`          | Two-byte value: auto 0, cool 1, heat 2, fan 3, dry 4 |
| Fan                         | `5d07`          | Two-byte value: high 0, medium 1, low 2, auto 3      |
| Vertical / horizontal swing | `4d22` / `4d23` | Two-byte value: off 0, on 1                          |

The existing `6001` bulk-write command is not used for this model. Each setting uses a fresh local handshake. Power-on runs before other changes, mode before temperature/fan/swing, and power-off last. Explicit changes override power-on preferences. Each command's reported result is checked before proceeding; compact acknowledgements or stale state trigger a fresh read. An ignored command produces an error instead of success. Multi-setting requests are sequential: earlier changes can remain applied if a later command fails.

Quiet and Eco writes are rejected before any command is sent, including when they come from power-on preferences. Individual Quiet/Eco write commands have not been established, and the reported single energy-saving flag cannot represent the bridge's L1/L2/L3 Eco levels. Quiet can be read; Eco is reported as unavailable. Remove Quiet/Eco from power-on preferences when using this model.

## Real-device verification

Automated capture and simulated-device tests are not hardware verification. Before calling this model confirmed:

1. Restart the bridge from the updated source. Use the existing device if its model ID is already stored; otherwise add it through Haismart discovery, or enter the ID in Advanced setup.
2. Read status and compare temperature, mode, fan, swing, and Quiet against the Haismart app or remote.
3. Test power off/on, then change temperature, mode, fan, and each swing setting individually. Confirm the physical AC responds and refresh status afterwards.
4. Test a combined request and power-on preferences without Quiet/Eco.
5. Report the retail model, firmware, observed readings, and which controls worked in issue #8. Exclude account credentials, local keys, serial numbers, and network addresses.
