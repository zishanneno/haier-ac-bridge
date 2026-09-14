# Compatibility

This bridge implements the local Haier uSS protocol used by some **Haismart** air conditioners. It is not a universal Haier integration.

## Current scope

- Haismart email/phone-password accounts using the Southeast Asia cloud service.
- Private IPv4 LAN addresses (10.x, 172.16–31.x, or 192.168.x); TCP 56800 for control.
- Existing protocol support for 125/127-byte status layouts, plus 209/210-byte extended reports for the explicitly matched model identifier in `src/protocol.ts`.
- Model `00000000000000008080000000041410`: 117-byte status reports and model-specific power, temperature, mode, fan, and swing commands. Captured status reports are covered by automated tests; real-device control verification is still pending. See [model details and testing](PROTOCOL-41410.md).
- Temperature controls from 16 through 30 °C in whole degrees. Available modes/features still depend on the AC.

The bridge has been used with my three ACs. Retail model numbers and firmware versions have not yet been recorded in a public compatibility matrix. The new onboarding flow is covered by mocked tests; that does not establish live cloud or hardware compatibility.

hOn, SmartAir2, other account services/regions, non-AC appliances, IPv6-only networks, and unknown control layouts are outside the supported scope. A Haier device appearing in discovery or the account list does not mean it is safe to control with this protocol.

## Report a tested model

Open a compatibility issue with the retail model number, firmware version if known, country/Haismart app region, bridge version, and whether power, temperature, each mode, fan, swing, Quiet, and Eco work. Exclude device serial numbers, account details, local keys, and network addresses.

The extended report model identifier is a product/protocol identifier shared by a model family, not a household's device serial number. Keep the model guard in place until another model's control layout has been verified.
