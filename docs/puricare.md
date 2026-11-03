# LG PuriCare AS651DWH0 / AIR_910604_WW

Native ThinQ2 state reporting and MQTT controls for firmware 371. No Home Assistant
installation, permanent Mac observer, or LG cloud connection is required by this
controller. It registers only the exact AIR_910604_WW model. Other appliance
controllers and the shared TLV parser are unchanged.

## Evidence and limits

Original receive-only fixtures are preserved verbatim:

- `puricare-captura.jsonl`: 50 incoming packets.
- `puricare-teste-completo.jsonl`: 40 incoming packets.

`puricare-power-control.jsonl` preserves eight complete records from the first
pasted power experiment. `puricare-control-tests.jsonl` preserves all 245 complete
JSON records from the full terminal log: 27 trials, 26 result records and 190 wire
records, all with valid CRCs. Prompts and incomplete non-JSON text were omitted;
missing records were not reconstructed. The failed/no-change first mode attempt
and attempts without a matching state response are retained, not counted as
successful state changes. Later trials establish each supported mode.

`puricare-control-annotations.json` records the owner's physical observations:

- The original observer/menu labels were wrong. Both writes and subsequent A7
  reads establish 13=Booster, 14=Normal, 16=Smart.
- Main fan value 8 is Auto. Values 2, 4, 6 and 7 remain numeric setting labels;
  no physical percentages or RPM are inferred.
- Booster values 2, 4, 6, 7 and 8 were confirmed; 8 is not assumed to mean Auto.
- Power, swing, light and timer trials include physical confirmations. The final
  timer cancellation has an A7 zero-minute response; the owner separately
  confirmed cancellation after the pasted log ended before its last result record.

Confirmed writes consist of one tag only, using the recorded 0x65 envelope and
CRC. The repeating 0x2D7–0x2D9 rows in fan-speed responses are not extra write
attachments or globally unique state fields. The intermediate
`0201040000008701100000EC3C` response is not interpreted as confirmation of a
setting. Published state changes come from valid A7 device notifications.

No initial queries, polling, masking changes, optimistic state publications,
implicit power/mode changes, automatic retries or state restoration are added.
Physical command testing occurred on the owner's appliance, with fan/booster
checks in Booster mode. Other firmware and mode-dependent restrictions are not
claimed to be hardware-validated.

## MQTT contract

With the default prefix, the base topic is
`rethink/18e271fb-81d6-45dd-818c-3034db55eb63`. That UUID is an example, not a
hard-coded restriction in the native controller: each registered appliance uses
its own device ID. Commands use `<base>/<property>/set`; states are retained at
`<base>/<property>`. Payloads and labels are case-sensitive.

| Property                    | State                           | Accepted command payloads |
| --------------------------- | ------------------------------- | ------------------------- |
| `power`                     | ON / OFF                        | ON / OFF                  |
| `mode`                      | Normal / Smart / Booster        | Normal / Smart / Booster  |
| `fan_speed`                 | 2 / 4 / 6 / 7 / Auto            | 2 / 4 / 6 / 7 / Auto      |
| `booster_speed`             | 2 / 4 / 6 / 7 / 8               | 2 / 4 / 6 / 7 / 8         |
| `swing`                     | ON / OFF                        | ON / OFF                  |
| `light`                     | ON / OFF                        | ON / OFF                  |
| `timer_minutes`             | Actual remaining minutes        | 0 / 120 / 240 / 480 / 720 |
| `fan_speed_raw`             | Raw 0x1FA, including 8 for Auto | Read-only                 |
| `booster_speed_raw`         | Raw 0x326                       | Read-only                 |
| `swing_raw`                 | Raw 0x327                       | Read-only                 |
| `air_measurement_raw_0x333` | Unknown measurement/units       | Read-only                 |
| `air_measurement_raw_0x334` | Unknown measurement/units       | Read-only                 |
| `air_measurement_raw_0x335` | Unknown measurement/units       | Read-only                 |
| `availability`              | online / offline                | Read-only                 |

All numeric wire payloads are decimal strings. Timer 0 cancels; countdown values
such as 479 are published unchanged but are not accepted as command presets.
Discovery separates the write-only timer preset selector from remaining minutes.
Unknown properties/payloads and commands after device cleanup send nothing.

Device availability indicates registration, not that all properties have already
been reported. Retained readings can be stale; the existing `rethink/availability`
service LWT is separate. A passive startup can initially lack some states until
the device notifies them. The observer's old `puricare/<UUID>/...` prefix and its
mode labels differ from this native contract.

## Homebridge MQTT-Thing / Apple Home

[The additive accessory array](examples/homebridge-puricare.json) follows the
MQTT-Thing project's documented [Air Purifier](https://github.com/arachnetech/homebridge-mqttthing/blob/master/docs/Accessories.md#air-purifier)
and [apply-function](https://github.com/arachnetech/homebridge-mqttthing/blob/master/docs/Configuration.md#apply-functions)
APIs. Merge these entries into the existing Homebridge `accessories` array using
the JSON configuration editor. Replace only any old PuriCare entries with the
same names; append if none exist. Preserve the configuration and the three
existing air-conditioner entries. The graphical topic form does not support
these apply functions.

The example assumes Homebridge uses host networking on the same CasaOS server,
so the existing loopback-only broker is reachable at `mqtt://127.0.0.1:1883`.
Reuse the broker URL already working for the other accessories if different.
No broker listener, DNS, certificates or credentials are changed. Being on the
same server alone does not make another container's loopback reachable.

The HomeKit representation is an explicit UI adapter, not new protocol evidence:

- The primary Air Purifier has power, swing and a four-position manual slider.
  Positions 25/50/75/100 select the validated settings 2/4/6/7; those percentages
  are selector positions, not measured airflow. Auto selects fan value 8 and
  does not report it as maximum speed. The last manual slider position is kept
  while Auto is active. Selecting Manual restores the last observed manual
  setting, or setting 2 when none is known in this Homebridge session.
- HomeKit Auto/Manual refers to fan Auto, independently of the physical Smart
  mode. Separate Smart and Booster switches choose their physical modes; turning
  either off selects Normal. The active state is reflected by MQTT.
- `CurrentAirPurifierState` is a UI projection of power (ON=PURIFYING,
  OFF=INACTIVE), not an independently measured air-treatment status. No unknown
  air measurement is advertised as PM, humidity, temperature or air quality.
- Light has its own control. Five Booster preset buttons send the validated
  numeric settings without assigning percentages or Auto semantics to them.
- Four timer preset buttons request 2/4/8/12 hours, plus one cancellation button.
  These are momentary request buttons, not countdown indicators. Their one-second
  UI reset sends no command. Actual remaining minutes remain available on MQTT;
  timing runs on the purifier, not in a permanent Mac script.
- The example uses the Rethink service LWT for Homebridge online status. Individual
  device availability is a separate MQTT topic and is not combined by this example.
  Command messages are not retained, no start-up commands are configured, and no
  MQTT-Thing confirmation/retry loop is enabled.

Offline tests exercise example transformations through the actual MQTT router
and native controller, comparing output bytes with captured appliance commands.
The example has not been applied to or tested in the owner's Homebridge runtime.

## Validation

Use the existing isolated checkout; no extra Git worktree is needed.

```sh
npm ci
npm run check
npm test
npm run build
```

Tests replay the original notifications, reproduce every supported write byte for
byte, validate corrected mode/Auto labels, ignore intermediate responses, reject
invalid inputs, preserve raw environmental data and actual timer countdowns,
exercise retained MQTT state/command routing, and verify cleanup and no unsolicited
transmissions. The full suite includes the existing air-conditioner tests; it is
software regression coverage, not certification of the owner's three physical units.

The terminal menu is bundled in the image and can be opened from any working
directory with `puricare-testes`. `puricare-testes --help` sends nothing. The menu
requires a whitelisted command and a physical result before another trial. It
records raw packets and observations to a private `/tmp` JSONL file and never
runs automatically with normal container startup. Its fixed UUID belongs only
to the owner's diagnostic session, not to the native model factory.

## Image and rollback

Native work is isolated on `feat/puricare-native-control`. The publishing workflow
gates image publication on TypeScript, all tests, build, the installed CLI and
isolated mock-device checks. It builds amd64, arm64 and armv7. `puricare-controle`
is the explicit native-control tag; legacy `puricare-leitura` and `puricare-testes`
are refreshed to the same image for the owner's existing Compose configuration.
An immutable `puricare-<commit>` tag is also published.

No production container is restarted by the workflow or this development task.
Keep the existing `/DATA/AppData/lg-rethink:/app/data` bind mount. An update needs
only the Rethink service to pull/recreate; the existing Mosquitto can stay running.
The previous read-only image with bundled tests remains available for rollback:

```text
ghcr.io/hkb54jp7bz-cell/rethink@sha256:43c2269248c79d61515c4251f64ea42f9378b1301ac2152f2c5c4ac1590152b0
```

Revert the model import/registration together with its controller/tests to remove
support at source level. Unknown environmental semantics and firmware-specific
features require separate evidence; no experimental packets are sent by setup,
build, native startup or automated tests.
