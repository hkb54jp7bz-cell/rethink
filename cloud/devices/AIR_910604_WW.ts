import HADevice from './base'
import type { Connection } from '../homeassistant'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Metadata } from '../thinq'
import crc16 from '@/util/crc16'
import * as TLV from '@/util/tlv'

// Receive-only mappings from the supplied AS651DWH0 captures (firmware 371).
// Raw fields deliberately have no inferred units, percentages or air-quality labels.
const fields = new Map<number, [string, ((value: number) => string | undefined)?]>([
    [0x1f7, ['power', (v) => ({ 0: 'OFF', 1: 'ON' })[v]]],
    [0x1f9, ['mode', (v) => ({ 13: 'Smart', 14: 'Booster', 16: 'Normal' })[v]]],
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

    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id, meta.modelId)
        const config = HADevice.config(meta, { name: 'LG PuriCare AS651DWH0' })
        for (const [name] of fields.values()) {
            const component = {
                platform: 'sensor',
                unique_id: '$deviceid-' + name,
                name,
                state_topic: '$this/' + name,
            }
            config.components[name] = component
        }
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
        }
    }

    override setProperty(_property: string, _value: string) {
        // No writes, queries, masking changes or optimistic state updates are validated.
    }

    override drop() {
        this.thinq.removeListener('data', this.onData)
        super.drop()
    }
}
