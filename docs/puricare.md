# LG PuriCare AS651DWH0 / AIR_910604_WW

## Scope and evidence

Native **receive-only** ThinQ2 support, verified offline against firmware 371 captures.
No queries, polling, masking changes, writes or optimistic state updates are sent.
The controller uses HADevice rather than TLVDevice because TLVDevice transmits a
capability query during construction. Shared protocol and appliance classes are unchanged.

Fixtures in `tests/fixtures/puricare/` preserve the two supplied JSONL files verbatim:

- `puricare-captura.jsonl`: 50 inbound packet records.
- `puricare-teste-completo.jsonl`: 40 inbound packet records.

Both identify AIR_910604_WW, firmware 371, device type 402. Every wire record is
fromDevice, packet, not injected. There are **no outbound commands**, acknowledgements
of writes, capability responses, or annotated command/result pairs in these files.
The supplied observer corroborates the read labels but is not independent evidence
for writes. The pasted observer output is decoded telemetry, not a command capture.

The parser accepts only the observed 00 00 04 00 00 00 A7 02 04 notification
header, checks payload length and CRC16-CCITT, and rejects incomplete TLVs atomically.
Unobserved frame dialects are deliberately not accepted. Unknown tags are ignored.
Repeated capability table tags 0x2D7–0x2D9 are not treated as current settings.

## MQTT contract

No Home Assistant installation is required. Rethink's existing MQTT connection
publishes retained states to the configured broker. With prefix `rethink`, the base
is `rethink/18e271fb-81d6-45dd-818c-3034db55eb63`. The UUID is an example, not a
hard-coded filter: other appliances reporting this exact model use their own UUID.

| Suffix                      | Read interpretation                      | Observed values        |
| --------------------------- | ---------------------------------------- | ---------------------- |
| `power`                     | 0 → OFF, 1 → ON                          | OFF, ON                |
| `mode`                      | 13 → Smart, 14 → Booster, 16 → Normal    | Smart, Booster, Normal |
| `fan_speed_raw`             | 0x1FA, no percentage conversion          | 2, 4, 6, 7, 8          |
| `booster_speed_raw`         | 0x326, no percentage conversion          | 2, 4, 6, 7, 8          |
| `swing_raw`                 | 0x327, raw state                         | 0, 1                   |
| `light`                     | 0x24E: 0 → OFF, 1 → ON                   | OFF, ON                |
| `timer_minutes`             | 0x21A, minutes per supplied observations | 0, 120, 240, 480, 720  |
| `air_measurement_raw_0x333` | Unknown measurement and units            | Raw integer            |
| `air_measurement_raw_0x334` | Unknown measurement and units            | Raw integer            |
| `air_measurement_raw_0x335` | Unknown measurement and units            | Raw integer            |
| `availability`              | Existing Rethink device lifecycle        | online, offline        |

All numeric MQTT payloads are decimal strings. Unknown power/light/mode codes
produce no new interpreted state. Nothing is defaulted before receipt. Availability
indicates registration/connection, not receipt of all fields. Combine device availability
with `rethink/availability` (global service LWT); retained readings can otherwise be stale.
A passive controller may not know every property until the appliance reports it.

The observer's `puricare/<UUID>/...` prefix is **not** the native Rethink prefix.
Its `Propulsor` and `Unico` labels correspond to native `Booster` and `Normal`.
No `/set` topic is advertised, and every attempted command is ignored.

## Homebridge MQTT-Thing

The existing Homebridge configuration was not supplied, so its current accessory
type, topics and plugin version have not been validated. MQTT-Thing can subscribe
to the above plain MQTT topics without Home Assistant discovery. A future `getOn`
state binding can use `<base>/power` with ON/OFF payload handling. Do not configure
`setOn` or other write topics yet: the native controller does not control the device.
Do not map raw speed to HomeKit percentages, raw air fields to PM/air-quality
characteristics, or the mode strings to HomeKit enums without an explicit validated
conversion. This release is telemetry support, not a completed controllable HomeKit
accessory. No existing Homebridge configuration is changed automatically.

## Validation and rollback

Use the existing isolated checkout; no extra Git worktree is needed.

```sh
cd /workspace/rethink
npm ci
npm run check
npm test
npm run build
```

Tests replay all 90 actual packets and cover state transitions, no default values,
retained MQTT serialization, model registration, no command discovery, rejected
commands, an hour of simulated runtime without sends, malformed frames, unknown
values and listener cleanup. Synthetic invalid frames are robustness cases only.
The existing full suite supplies offline regression coverage for other models,
including RAC_056905_WW and its variants; this does not certify physical appliances.

Work is isolated on branch `feat/puricare-air-910604-ww`. Revert the model import
and registration together with this controller, tests, fixtures and documentation
to remove support. No production deployment was performed. A future deployment
must preserve the previous image and configuration for rollback and requires
separate authorization. Physical checks and experimental packets also require
explicit authorization.

## Next evidence needed for control

For each proposed write, obtain an authorized capture of a known command with
its full outbound frame, direction, requested setting, response and resulting state.
Check envelope, CRC, tag encoding, mode-dependent attached TLVs and rejection
behavior separately. Inbound A7 state notifications do not establish outbound
write framing or rules. Do not copy the dehumidifier/air-conditioner write logic.
No physical capture or test is initiated by this implementation.

## Interactive experimental terminal probe

`tools/puricare-terminal-test.mjs` is a separate opt-in diagnostic tool for the
owner-authorized physical experiments. It does not enable native MQTT commands.
The rebuilt image includes the script and a launcher. In the Rethink container terminal:

```sh
puricare-testes
```

`puricare-testes --help` displays help without contacting the management interface.
The launcher uses `/usr/bin/node` and `/app/tools/puricare-terminal-test.mjs`, so it
works from any working directory. The normal container startup still runs Rethink;
the menu does not run automatically. The Mosquitto image remains unchanged.

The script itself only prints the menu without `--execute`; the installed launcher
adds that option by default. In an active session the tool first verifies the
fixed purifier UUID/model through the management interface. It sends no appliance
packet until the user enters a whitelisted menu command. Each candidate uses
read values from the captures and the shared TLV encoder; its suitability as a
write is still a hypothesis. Commands are serialized behind physical result
reporting (`ok` or `nao`), not automatically retried. Ambient tags have no write
commands. No polling, certificate changes, or container restart is performed.

Each run records raw outbound/inbound packets, CRC-checked state observations,
trial IDs, and the user's physical observations in a private `/tmp` JSONL file.
An echoed value is recorded separately from a physical change; it does not on
its own validate a write. `sair` ends the session and prints the capture path.
Settings are not automatically restored. Test different values from the current
state and cancel timer experiments with `timer 0`, checking the physical panel.

The published read-only image was used to test this tool with networking disabled
and a mock management server: all 24 whitelisted candidate values, invalid input
rejection, one pending write at a time, raw capture/result correlation, wrong
model/offline rejection, and the default dry run. These are software checks, not
physical appliance validation. The reproducible container harness is
`tests/tools/puricare-terminal-test.docker.mjs`; mount the probe at
`/app/tools/puricare-terminal-test.mjs` and the harness at `/app/puricare-menu-harness.mjs`
inside the published image, and run the latter with `--network none`.

The `Publish PuriCare image with terminal menu` workflow builds an amd64 image,
checks the installed launcher, and runs the mock-device harness with networking
disabled before publishing amd64/arm64/armv7 images. It publishes `puricare-testes`
and refreshes `puricare-leitura` with the same native read-only controller, so
CasaOS can update the existing configured image without a Compose edit. The
previous image remains available at digest
`sha256:6cd7469f7d65638a603d2a9e5651b4aeefaa7448700ed48e725a217d7ffd80a9`.
No container on the owner's server is restarted by this workflow.
