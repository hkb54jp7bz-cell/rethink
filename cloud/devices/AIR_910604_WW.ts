import HADevice from './base'
import type { Connection } from '../homeassistant'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Metadata } from '../thinq'
import crc16 from '@/util/crc16'
import * as TLV from '@/util/tlv'

// Separately checked writes, notifications, and physical labels are preserved in
// puricare-control-tests.jsonl and puricare-control-annotations.json.
const MODES = { Normal: 14, Smart: 16, Booster: 13 } as const
const FAN_SPEEDS = { '2': 2, '4': 4, '6': 6, '7': 7, Auto: 8 } as const
const BOOSTER_SPEEDS = { '2': 2, '4': 4, '6': 6, '7': 7, '8': 8 } as const
const TIMERS = { '0': 0, '120': 120, '240': 240, '480': 480, '720': 720 } as const
const SWITCH_TAGS = { power: 0x1f7, swing: 0x327, light: 0x24e } as const
const MODE_NAMES = new Map<number, string>(Object.entries(MODES).map(([name, value]) => [value, name]))
const FAN_NAMES = new Map<number, string>(Object.entries(FAN_SPEEDS).map(([name, value]) => [value, name]))

// Read mappings from the supplied AS651DWH0 captures (firmware 371).
// Raw fields deliberately have no inferred units, percentages or air-quality labels.
const fields = new Map<number, [string, ((value: number) => string | undefined)?]>([
    [0x1f7, ['power', (v) => ({ 0: 'OFF', 1: 'ON' })[v]]],
    [0x1f9, ['mode', (v) => MODE_NAMES.get(v)]],
    [0x1fa, ['fan_speed_raw']],
    [0x326, ['booster_speed_raw']],
    [0x327, ['swing_raw']],
    [0x24e, ['light', (v) => ({ 0: 'OFF', 1: 'ON' })[v]]],
    [0x21a, ['timer_minutes']],
    [0x333, ['air_measurement_raw_0x333']],
    [0x334, ['air_measurement_raw_0x334']],
    [0x335, ['air_measurement_raw_0x335']],
])

// Do not extend TLVDevice: its constructor and timers transmit unverified queries.
export default class Device extends HADevice {
    private readonly onData = (packet: Buffer) => this.processData(packet)
    private dropped = false

    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id, meta.modelId)
        const config = HADevice.config(meta, { name: 'LG PuriCare AS651DWH0' })
        for (const [name] of fields.values()) {
            const component = {
                platform: name === 'power' || name === 'light' ? 'switch' : 'sensor',
                unique_id: '$deviceid-' + name,
                name,
                state_topic: '$this/' + name,
                ...(name === 'power' || name === 'light'
                    ? { command_topic: '$this/' + name + '/set', payload_on: 'ON', payload_off: 'OFF' }
                    : {}),
                ...(name === 'mode'
                    ? { platform: 'select', command_topic: '$this/mode/set', options: Object.keys(MODES) }
                    : {}),
            }
            config.components[name] = component
        }
        for (const [name, options] of [
            ['fan_speed', Object.keys(FAN_SPEEDS)],
            ['booster_speed', Object.keys(BOOSTER_SPEEDS)],
        ] as const) {
            const component = {
                platform: 'select',
                unique_id: '$deviceid-' + name,
                name,
                state_topic: '$this/' + name,
                command_topic: '$this/' + name + '/set',
                options: [...options],
            }
            config.components[name] = component
        }
        const swingComponent = {
            platform: 'switch',
            unique_id: '$deviceid-swing',
            name: 'Swing',
            state_topic: '$this/swing',
            command_topic: '$this/swing/set',
            payload_on: 'ON',
            payload_off: 'OFF',
        }
        config.components.swing = swingComponent
        // A write-only preset selector is separate from the actual remaining minutes.
        // Countdown values such as 479 are valid readings, not selectable presets.
        const timerComponent = {
            platform: 'select',
            unique_id: '$deviceid-timer_preset',
            name: 'Sleep timer preset (minutes)',
            command_topic: '$this/timer_minutes/set',
            options: Object.keys(TIMERS),
        }
        config.components.timer_preset = timerComponent
        thinq.on('data', this.onData)
        this.setConfig(config)
    }

    processData(packet: Buffer) {
        if (
            packet.length < 13 ||
            packet[0] !== 0 ||
            packet[1] !== 0 ||
            packet[2] !== 4 ||
            packet[3] !== 0 ||
            packet[4] !== 0 ||
            packet[5] !== 0 ||
            packet[6] !== 0xa7 ||
            packet[7] !== 2 ||
            packet[8] !== 4 ||
            packet[10] !== packet.length - 13 ||
            crc16(packet.subarray(2)) !== 0
        )
            return

        const payload = packet.subarray(11, -2)
        // The shared parser accepts partial TLVs. Reject the whole malformed notification
        // before publishing anything, without changing parsing for other appliances.
        for (let offset = 0; offset < payload.length; ) {
            if (offset + 2 > payload.length) return
            const length = 2 + ((payload[offset + 1] >> 4) & 3)
            if (offset + length > payload.length) return
            offset += length
        }
        for (const { t, v } of TLV.parse(payload)) {
            const field = fields.get(t)
            if (!field) continue
            const [name, transform] = field
            const value = transform ? transform(v) : v
            if (value !== undefined) this.publishProperty(name, value)
            if (t === 0x1fa) {
                const fan = FAN_NAMES.get(v)
                if (fan !== undefined) this.publishProperty('fan_speed', fan)
            }
            if (t === 0x326 && Object.prototype.hasOwnProperty.call(BOOSTER_SPEEDS, String(v)))
                this.publishProperty('booster_speed', String(v))
            if (t === 0x327 && (v === 0 || v === 1)) this.publishProperty('swing', v === 1 ? 'ON' : 'OFF')
        }
    }

    override setProperty(property: string, value: string) {
        if (this.dropped) return
        let tag: number
        let raw: number
        if (Object.prototype.hasOwnProperty.call(SWITCH_TAGS, property) && (value === 'ON' || value === 'OFF')) {
            tag = SWITCH_TAGS[property as keyof typeof SWITCH_TAGS]
            raw = value === 'ON' ? 1 : 0
        } else if (property === 'mode' && Object.prototype.hasOwnProperty.call(MODES, value)) {
            tag = 0x1f9
            raw = MODES[value as keyof typeof MODES]
        } else if (property === 'fan_speed' && Object.prototype.hasOwnProperty.call(FAN_SPEEDS, value)) {
            tag = 0x1fa
            raw = FAN_SPEEDS[value as keyof typeof FAN_SPEEDS]
        } else if (property === 'booster_speed' && Object.prototype.hasOwnProperty.call(BOOSTER_SPEEDS, value)) {
            tag = 0x326
            raw = BOOSTER_SPEEDS[value as keyof typeof BOOSTER_SPEEDS]
        } else if (property === 'timer_minutes' && Object.prototype.hasOwnProperty.call(TIMERS, value)) {
            tag = 0x21a
            raw = TIMERS[value as keyof typeof TIMERS]
        } else return

        // Reproduce the observed single-tag writes; the repeating capability rows
        // in the fan responses do not establish any extra write attachments.
        const tlvs = TLV.build([{ t: tag, v: raw }])
        const body = [4, 0, 0, 0, 0x65, 2, 1, 1, tlvs.length, ...tlvs]
        const crc = crc16(body)
        this.thinq.send_packet(Buffer.from([1, 1, ...body, crc >> 8, crc & 255]))
        // Publish only actual device notifications, never optimistic state changes.
    }

    override drop() {
        this.dropped = true
        this.thinq.removeListener('data', this.onData)
        super.drop()
    }
}
