import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Device from '@/cloud/devices/AIR_910604_WW'
import Bridge from '@/cloud/ha_bridge'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers } from '@/tests/helpers/timers'
import crc16 from '@/util/crc16'

const ID = '18e271fb-81d6-45dd-818c-3034db55eb63'
const META = { modelId: 'AIR_910604_WW', modelName: 'AIR_910604_WW', swVersion: '371' }
function setup() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(ID, META)
    const device = new Device(ha.asConnection(), thinq, META)
    return { ha, thinq, device }
}
const POWER_OFF = '000004000000a70204560e7dc09380cd40cd00ccc090409000dbca'
const POWER_ON = '000004000000a7020457047dc1938175de'

for (const [file, count] of [
    ['puricare-captura.jsonl', 50],
    ['puricare-teste-completo.jsonl', 40],
] as const) {
    test(`replay every real frame in ${file}`, (t) => {
        const { ha, thinq, device } = setup()
        t.after(() => device.drop())
        const rows = readFileSync(new URL('../../fixtures/puricare/' + file, import.meta.url), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        const frames = rows.filter(
            (r) => r.k === 'wire' && r.dir === 'fromDevice' && r.type === 'packet' && !r.injected,
        )
        assert.equal(frames.length, count)
        const observed: Record<string, Set<string | number>> = {}
        for (const frame of frames) {
            assert.equal(crc16(buf(frame.hex).subarray(2)), 0)
            thinq.emit('data', buf(frame.hex))
            for (const [key, value] of Object.entries(ha.devices[ID].properties)) {
                ;(observed[key] ??= new Set()).add(value)
            }
        }
        const values = (key: string) => [...observed[key]].sort()
        assert.deepEqual(values('power'), ['OFF', 'ON'])
        assert.deepEqual(values('mode'), ['Booster', 'Normal', 'Smart'])
        assert.deepEqual(values('fan_speed_raw'), [2, 4, 6, 7, 8])
        assert.deepEqual(values('booster_speed_raw'), [2, 4, 6, 7, 8])
        assert.deepEqual(values('light'), ['OFF', 'ON'])
        assert.deepEqual(values('swing_raw'), [0, 1])
        assert.deepEqual(
            values('timer_minutes'),
            file === 'puricare-captura.jsonl' ? [0, 120, 240, 480, 720] : [0, 120],
        )
        assert.deepEqual(
            Object.keys(observed).sort(),
            [
                'power',
                'mode',
                'fan_speed_raw',
                'booster_speed_raw',
                'light',
                'swing_raw',
                'timer_minutes',
                'air_measurement_raw_0x333',
                'air_measurement_raw_0x334',
                'air_measurement_raw_0x335',
            ].sort(),
        )
        assert.deepEqual(thinq.outbox, [])
        assert.deepEqual(thinq.sent, [])
    })
}

test('real multi-field notifications publish exact states without defaults', (t) => {
    const { ha, thinq, device } = setup()
    t.after(() => device.drop())
    assert.deepEqual(ha.devices[ID].properties, {})
    thinq.emit('data', buf(POWER_OFF))
    assert.deepEqual(ha.devices[ID].properties, {
        power: 'OFF',
        light: 'OFF',
        air_measurement_raw_0x335: 0,
        air_measurement_raw_0x334: 0,
        air_measurement_raw_0x333: 0,
    })
    thinq.emit('data', buf(POWER_ON))
    assert.equal(ha.devices[ID].properties.power, 'ON')
    assert.equal(ha.devices[ID].properties.light, 'ON')
})

// Synthetic invalid inputs are robustness tests, not evidence of appliance behavior.
function withCRC(packet: Buffer) {
    const crc = crc16(packet.subarray(2, -2))
    packet.writeUInt16BE(crc, packet.length - 2)
    return packet
}
test('rejects malformed, wrong-type, wrong-marker and corrupt frames atomically', (t) => {
    const { ha, thinq, device } = setup()
    t.after(() => device.drop())
    for (let i = 0; i < buf(POWER_ON).length; i++) thinq.emit('data', buf(POWER_ON).subarray(0, i))
    for (const offset of [0, 1, 2, 3, 4, 5, 6, 7, 8, 10]) {
        const wrong = buf(POWER_ON)
        wrong[offset] ^= 1
        thinq.emit('data', withCRC(wrong))
    }
    const corrupt = buf(POWER_ON)
    corrupt[11] ^= 1
    thinq.emit('data', corrupt)
    // Valid power TLV followed by an incomplete three-byte value.
    thinq.emit('data', withCRC(buf('000004000000a7020400047dc193b00000')))
    assert.deepEqual(ha.devices[ID].properties, {})
})

test('unknown enum values do not publish guessed labels', (t) => {
    const { ha, thinq, device } = setup()
    t.after(() => device.drop())
    thinq.emit('data', withCRC(buf('000004000000a7020400067dc27e4f93820000')))
    assert.deepEqual(ha.devices[ID].properties, {})
})

test('registration, lifecycle and all MQTT commands remain passive', (t) => {
    enableMockTimers(t)
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(ID, META)
    const bridge = new Bridge(ha.asConnection())
    bridge.newDevice(thinq)
    assert.equal(thinq.managed, true)
    const device = bridge.haDevices.get(ID)!
    assert.ok(device instanceof Device)
    for (const key of Object.keys(ha.devices[ID].config!.components)) {
        ha.emit('setProperty', ID, key, 'ON')
        ha.emit('setProperty', ID, key, 'invalid')
    }
    ha.emit('setProperty', ID, 'unknown', '1')
    t.mock.timers.tick(60 * 60 * 1000)
    assert.doesNotMatch(JSON.stringify(ha.devices[ID].config), /command_topic/)
    assert.deepEqual(thinq.outbox, [])
    assert.deepEqual(thinq.sent, [])
    thinq.emit('data', buf(POWER_ON))
    assert.equal(ha.devices[ID].properties.power, 'ON')
    thinq.emit('close')
    assert.equal(thinq.listenerCount('data'), 0)
    assert.equal(ha.devices[ID].availability, 'offline')
    thinq.emit('data', buf(POWER_OFF))
    assert.equal(ha.devices[ID].properties.power, 'ON')
    assert.equal(bridge.haDevices.size, 0)
})

test('real MQTT publisher serializes retained topics and suppresses duplicate state', async (t) => {
    const { Connection } = await import('@/cloud/homeassistant')
    const mqtt = Object.create(Connection.prototype) as InstanceType<typeof Connection>
    const published: Array<{ topic: string; value: string; options?: { retain?: boolean } }> = []
    Object.assign(mqtt, {
        config: { rethink_prefix: 'rethink', discovery_prefix: 'homeassistant' },
        publishedAvailability: new Set<string>(),
        client: {
            publish: (topic: string, value: string, options?: { retain?: boolean }) =>
                published.push({ topic, value, options }),
        },
    })
    const thinq = new MockThinq2Device(ID, META)
    const device = new Device(mqtt, thinq, META)
    t.after(() => device.drop())
    const discovery = published.find((p) => p.topic.endsWith('/config'))!
    assert.ok(discovery)
    assert.doesNotMatch(discovery.value, /command_topic|\$this|\$deviceid/)
    published.length = 0
    thinq.emit('data', buf(POWER_OFF))
    assert.deepEqual(published, [
        { topic: `rethink/${ID}/power`, value: 'OFF', options: { retain: true } },
        { topic: `rethink/${ID}/light`, value: 'OFF', options: { retain: true } },
        { topic: `rethink/${ID}/air_measurement_raw_0x335`, value: '0', options: { retain: true } },
        { topic: `rethink/${ID}/air_measurement_raw_0x334`, value: '0', options: { retain: true } },
        { topic: `rethink/${ID}/air_measurement_raw_0x333`, value: '0', options: { retain: true } },
    ])
    thinq.emit('data', buf(POWER_OFF))
    assert.equal(published.length, 5)
})
