import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Device from '@/cloud/devices/AIR_910604_WW'
import Bridge from '@/cloud/ha_bridge'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers } from '@/tests/helpers/timers'
import crc16 from '@/util/crc16'
import * as TLV from '@/util/tlv'
import { Connection } from '@/cloud/homeassistant'
import type { IPublishPacket } from 'mqtt'

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
// Only complete JSON records supplied by the user; the first pasted line was truncated.
const POWER_EVIDENCE = readFileSync(
    new URL('../../fixtures/puricare/puricare-power-control.jsonl', import.meta.url),
    'utf8',
)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
const CONTROL_EVIDENCE = readFileSync(
    new URL('../../fixtures/puricare/puricare-control-tests.jsonl', import.meta.url),
    'utf8',
)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

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
        assert.deepEqual(values('fan_speed'), ['2', '4', '6', '7', 'Auto'])
        assert.deepEqual(values('booster_speed_raw'), [2, 4, 6, 7, 8])
        assert.deepEqual(values('booster_speed'), ['2', '4', '6', '7', '8'])
        assert.deepEqual(values('light'), ['OFF', 'ON'])
        assert.deepEqual(values('swing_raw'), [0, 1])
        assert.deepEqual(values('swing'), ['OFF', 'ON'])
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
                'fan_speed',
                'booster_speed_raw',
                'booster_speed',
                'light',
                'swing_raw',
                'swing',
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

test('registration, lifecycle and unvalidated MQTT commands remain passive', (t) => {
    enableMockTimers(t)
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(ID, META)
    const bridge = new Bridge(ha.asConnection())
    bridge.newDevice(thinq)
    assert.equal(thinq.managed, true)
    const device = bridge.haDevices.get(ID)!
    assert.ok(device instanceof Device)
    for (const key of Object.keys(ha.devices[ID].config!.components)) {
        if (!['power', 'light', 'swing'].includes(key)) ha.emit('setProperty', ID, key, 'ON')
        ha.emit('setProperty', ID, key, 'invalid')
    }
    ha.emit('setProperty', ID, 'unknown', '1')
    t.mock.timers.tick(60 * 60 * 1000)
    const components = ha.devices[ID].config!.components
    assert.equal(ha.lookupTopic(ID, 'power', 'command'), 'power/set')
    for (const [key, component] of Object.entries(components)) {
        if (!['power', 'mode', 'fan_speed', 'booster_speed', 'swing', 'light', 'timer_preset'].includes(key))
            assert.doesNotMatch(JSON.stringify(component), /command_topic/)
    }
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
    device.setProperty('power', 'OFF')
    assert.deepEqual(thinq.outbox, [])
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
    assert.doesNotMatch(discovery.value, /\$this|\$deviceid/)
    const components = JSON.parse(discovery.value).components
    assert.equal(components.power.platform, 'switch')
    assert.equal(components.power.command_topic, `rethink/${ID}/power/set`)
    assert.equal(components.power.payload_on, 'ON')
    assert.equal(components.power.payload_off, 'OFF')
    assert.equal(Object.values(components).filter((c: any) => c.command_topic).length, 7)
    assert.equal(components.mode.command_topic, `rethink/${ID}/mode/set`)
    assert.deepEqual(components.mode.options, ['Normal', 'Smart', 'Booster'])
    assert.equal(components.fan_speed.command_topic, `rethink/${ID}/fan_speed/set`)
    assert.deepEqual(components.fan_speed.options, ['2', '4', '6', '7', 'Auto'])
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

for (const payload of ['OFF', 'ON'] as const) {
    test(`power ${payload} reproduces the physically confirmed write and waits for state feedback`, (t) => {
        const { ha, thinq, device } = setup()
        t.after(() => device.drop())
        const result = POWER_EVIDENCE.find((r) => r.k === 'result' && r.command === `energia ${payload}`)
        assert.ok(result?.physicalChange && result.txObserved && result.matchingResponse)
        const previous = payload === 'ON' ? 'OFF' : 'ON'
        thinq.emit('data', buf(payload === 'ON' ? POWER_OFF : POWER_ON))
        assert.equal(ha.devices[ID].properties.power, previous)

        device.setProperty('power', payload)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex').toUpperCase(), result.packet)
        assert.equal(crc16(thinq.outbox[0].subarray(2)), 0)
        assert.equal(ha.devices[ID].properties.power, previous)
        const responses = POWER_EVIDENCE.filter(
            (r) => r.k === 'wire' && r.dir === 'fromDevice' && r.trialId === result.trialId,
        )
        assert.equal(responses.length, 2)
        thinq.emit('data', buf(responses[0].hex)) // A transport response is not a power state.
        assert.equal(ha.devices[ID].properties.power, previous)
        thinq.emit('data', buf(responses[1].hex))
        assert.equal(ha.devices[ID].properties.power, payload)
        assert.equal(thinq.outbox.length, 1)
        assert.deepEqual(thinq.sent, [])
    })
}

test('invalid payloads and read-only properties emit no packet', (t) => {
    const { ha, thinq, device } = setup()
    t.after(() => device.drop())
    for (const value of ['on', 'off', 'true', 'false', '1', '0', '', ' ON', 'ON ', 'invalid'])
        device.setProperty('power', value)
    for (const prop of [
        'mode',
        'fan_speed_raw',
        'booster_speed_raw',
        'swing_raw',
        'timer_minutes',
        'air_measurement_raw_0x333',
        'unknown',
    ]) {
        device.setProperty(prop, 'ON')
        device.setProperty(prop, '1')
    }
    for (const [prop, values] of [
        ['light', ['on', 'off', '1', '0', 'invalid']],
        ['swing', ['on', 'off', '1', '0', 'invalid']],
        ['mode', ['smart', 'normal', 'booster', '13', '14', '16', 'constructor']],
        ['fan_speed', ['8', 'auto', '0', '3', '100', 'constructor']],
        ['booster_speed', ['Auto', '0', '3', '100', 'constructor']],
        ['timer_minutes', ['-1', '60', '360', '479', '600', '721', 'NaN', '120.0', '0120']],
    ] as const)
        for (const value of values) device.setProperty(prop, value)
    assert.deepEqual(thinq.outbox, [])
    assert.deepEqual(thinq.sent, [])
    assert.deepEqual(ha.devices[ID].properties, {})
})

test('real MQTT command routing targets only this device and the confirmed controls', (t) => {
    const ha = new MockHAConnection()
    Object.assign(ha, { config: { rethink_prefix: 'rethink', discovery_prefix: 'homeassistant' } })
    const thinq = new MockThinq2Device(ID, META)
    const bridge = new Bridge(ha.asConnection())
    bridge.newDevice(thinq)
    t.after(() => thinq.emit('close'))
    const receive = (topic: string, payload: string) =>
        Connection.prototype.received.call(ha.asConnection(), topic, Buffer.from(payload), {
            retain: false,
        } as IPublishPacket)
    receive(`rethink/not-this-device/power/set`, 'OFF')
    receive(`other-prefix/${ID}/power/set`, 'OFF')
    receive(`rethink/${ID}/mode/set`, 'Unknown')
    receive(`rethink/${ID}/power/set`, 'invalid')
    assert.equal(thinq.outbox.length, 0)
    for (const value of ['OFF', 'ON']) receive(`rethink/${ID}/power/set`, value)
    assert.deepEqual(
        thinq.outbox.map((p) => p.toString('hex').toUpperCase()),
        POWER_EVIDENCE.filter((r) => r.k === 'result').map((r) => r.packet),
    )
    assert.deepEqual(ha.devices[ID].properties, {})
})

const CONTROL_CASES = [
    { trialId: 5, property: 'mode', payload: 'Smart' },
    { trialId: 6, property: 'mode', payload: 'Normal' },
    { trialId: 7, property: 'mode', payload: 'Booster' },
    ...[2, 4, 6, 7, 'Auto'].map((value, index) => ({
        trialId: 8 + index,
        property: 'fan_speed',
        payload: String(value),
    })),
    ...[2, 4, 6, 7, 8].map((value, index) => ({
        trialId: 13 + index,
        property: 'booster_speed',
        payload: String(value),
    })),
    { trialId: 18, property: 'swing', payload: 'OFF' },
    { trialId: 19, property: 'swing', payload: 'ON' },
    { trialId: 20, property: 'light', payload: 'OFF' },
    { trialId: 21, property: 'light', payload: 'ON' },
    ...[120, 240, 480, 720].map((value, index) => ({
        trialId: 23 + index,
        property: 'timer_minutes',
        payload: String(value),
    })),
    { trialId: 27, property: 'timer_minutes', payload: '0' },
]
function notificationFields(record: any) {
    if (record.k !== 'wire' || record.dir !== 'fromDevice' || record.injected) return []
    const packet = buf(record.hex)
    if (packet.subarray(0, 9).toString('hex') !== '000004000000a70204') return []
    assert.equal(crc16(packet.subarray(2)), 0)
    return TLV.parse(packet.subarray(11, -2))
}
for (const example of CONTROL_CASES) {
    test(`captured trial ${example.trialId}: ${example.property} ${example.payload} has exact write and actual readback`, (t) => {
        const { ha, thinq, device } = setup()
        t.after(() => device.drop())
        const trial = CONTROL_EVIDENCE.find((r) => r.k === 'trial' && r.trialId === example.trialId)
        const tx = CONTROL_EVIDENCE.find((r) => r.k === 'wire' && r.dir === 'toDevice' && r.trialId === example.trialId)
        const result = CONTROL_EVIDENCE.find((r) => r.k === 'result' && r.trialId === example.trialId)
        assert.ok(trial && tx)
        if (example.trialId === 27) {
            const annotations = JSON.parse(
                readFileSync(
                    new URL('../../fixtures/puricare/puricare-control-annotations.json', import.meta.url),
                    'utf8',
                ),
            )
            assert.equal(
                annotations.timer_cancel.final_physical_confirmation_record,
                'Owner reply in conversation: Sim, cancelado',
            )
            assert.equal(trial.previousValue, 720)
        } else assert.ok(result?.physicalChange && result.txObserved && result.matchingResponse)
        const feedback = CONTROL_EVIDENCE.find(
            (r) =>
                r.trialId === example.trialId &&
                notificationFields(r).some(({ t, v }) => t === trial.tag && v === trial.value),
        )
        assert.ok(feedback)
        assert.equal(tx.hex.toUpperCase(), trial.packet)

        device.setProperty(example.property, example.payload)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), tx.hex.toLowerCase())
        assert.equal(crc16(thinq.outbox[0].subarray(2)), 0)
        assert.deepEqual(ha.devices[ID].properties, {})
        const ack = CONTROL_EVIDENCE.find(
            (r) =>
                r.k === 'wire' &&
                r.dir === 'fromDevice' &&
                r.trialId === example.trialId &&
                r.hex === '0201040000008701100000ec3c',
        )
        assert.ok(ack)
        thinq.emit('data', buf(ack.hex))
        assert.deepEqual(ha.devices[ID].properties, {})
        thinq.emit('data', buf(feedback.hex))
        const expected: string | number =
            example.property === 'timer_minutes' ? Number(example.payload) : example.payload
        assert.equal(ha.devices[ID].properties[example.property], expected)
        if (example.property === 'fan_speed') assert.equal(ha.devices[ID].properties.fan_speed_raw, trial.value)
        if (example.property === 'booster_speed') assert.equal(ha.devices[ID].properties.booster_speed_raw, trial.value)
        if (example.property === 'swing') assert.equal(ha.devices[ID].properties.swing_raw, trial.value)
        if (example.trialId === 23) assert.equal(ha.devices[ID].properties.light, 'OFF')
        if (example.trialId === 27) assert.equal(ha.devices[ID].properties.light, 'ON')
        assert.equal(thinq.outbox.length, 1)
        assert.deepEqual(thinq.sent, [])
    })
}

test('full capture preserves no-change attempts and does not turn transport acknowledgements into state', () => {
    assert.equal(CONTROL_EVIDENCE.length, 245)
    const wire = CONTROL_EVIDENCE.filter((r) => r.k === 'wire')
    assert.equal(wire.length, 190)
    for (const record of wire) assert.equal(crc16(buf(record.hex).subarray(2)), 0)
    const firstModeAttempt = CONTROL_EVIDENCE.find((r) => r.k === 'result' && r.trialId === 3)
    assert.equal(firstModeAttempt.physicalChange, false)
    assert.equal(firstModeAttempt.matchingResponse, false)
})

test('timer countdown reports actual remaining minutes without rounding or reissuing commands', (t) => {
    const { ha, thinq, device } = setup()
    t.after(() => device.drop())
    const countdown = CONTROL_EVIDENCE.find((r) => notificationFields(r).some(({ t, v }) => t === 0x21a && v === 479))
    assert.ok(countdown)
    thinq.emit('data', buf(countdown.hex))
    assert.equal(ha.devices[ID].properties.timer_minutes, 479)
    assert.deepEqual(thinq.outbox, [])
    assert.equal(ha.lookupTopic(ID, 'timer_preset', 'command'), 'timer_minutes/set')
    assert.equal(ha.lookupTopic(ID, 'timer_preset', 'state'), undefined)
})

test('all confirmed command topics route through the existing MQTT connection', (t) => {
    const ha = new MockHAConnection()
    Object.assign(ha, { config: { rethink_prefix: 'rethink', discovery_prefix: 'homeassistant' } })
    const thinq = new MockThinq2Device(ID, META)
    const bridge = new Bridge(ha.asConnection())
    bridge.newDevice(thinq)
    t.after(() => thinq.emit('close'))
    for (const example of CONTROL_CASES) {
        const trial = CONTROL_EVIDENCE.find((r) => r.k === 'trial' && r.trialId === example.trialId)
        Connection.prototype.received.call(
            ha.asConnection(),
            `rethink/${ID}/${example.property}/set`,
            Buffer.from(example.payload),
            { retain: false } as IPublishPacket,
        )
        assert.equal(thinq.outbox[thinq.outbox.length - 1].toString('hex').toUpperCase(), trial.packet)
    }
    assert.equal(thinq.outbox.length, CONTROL_CASES.length)
    thinq.emit('close')
    for (const example of CONTROL_CASES)
        Connection.prototype.received.call(
            ha.asConnection(),
            `rethink/${ID}/${example.property}/set`,
            Buffer.from(example.payload),
            { retain: false } as IPublishPacket,
        )
    assert.equal(thinq.outbox.length, CONTROL_CASES.length)
})
