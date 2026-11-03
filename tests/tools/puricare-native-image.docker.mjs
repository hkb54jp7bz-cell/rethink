// Offline distribution test: only EventEmitters stand in for the appliance/MQTT.
// Run inside the built image with --network none and the actual capture mounted.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import Bridge from './dist/cloud/ha_bridge.js'
import { Connection } from './dist/cloud/homeassistant.js'
import * as TLV from './dist/util/tlv.js'

const records = readFileSync('/app/puricare-control-tests.jsonl', 'utf8').trim().split('\n').map(JSON.parse)
const id = '18e271fb-81d6-45dd-818c-3034db55eb63'
const state = {}
const sent = []
const ha = Object.assign(new EventEmitter(), {
    config: { rethink_prefix: 'rethink', discovery_prefix: 'homeassistant' },
    publishConfig() {},
    publishProperty(_id, key, value) {
        state[key] = value
    },
})
const device = Object.assign(new EventEmitter(), {
    id,
    platform: 'thinq2',
    meta: { modelId: 'AIR_910604_WW', modelName: 'AS651DWH0', swVersion: '371' },
    send_packet(packet) {
        sent.push(packet)
    },
    send() {
        throw new Error('Unexpected auxiliary command')
    },
})
const bridge = new Bridge(ha)
bridge.newDevice(device)
assert.equal(device.managed, true)
assert.equal(sent.length, 0)
const trialIds = [1, 2, 5, 6, 7, ...Array.from({ length: 14 }, (_, i) => i + 8), 23, 24, 25, 26, 27]
assert.equal(trialIds.length, 24)
function fields(row) {
    if (row.k !== 'wire' || row.dir !== 'fromDevice') return []
    const b = Buffer.from(row.hex, 'hex')
    if (b.subarray(0, 9).toString('hex') !== '000004000000a70204') return []
    return TLV.parse(b.subarray(11, -2))
}
function target(trial) {
    const { tag, value } = trial
    if (tag === 0x1f7) return ['power', value ? 'ON' : 'OFF']
    if (tag === 0x1f9) return ['mode', { 13: 'Booster', 14: 'Normal', 16: 'Smart' }[value]]
    if (tag === 0x1fa) return ['fan_speed', value === 8 ? 'Auto' : String(value)]
    if (tag === 0x326) return ['booster_speed', String(value)]
    if (tag === 0x327) return ['swing', value ? 'ON' : 'OFF']
    if (tag === 0x24e) return ['light', value ? 'ON' : 'OFF']
    if (tag === 0x21a) return ['timer_minutes', String(value)]
    throw new Error('Unknown trial')
}
for (const trialId of trialIds) {
    const trial = records.find((r) => r.k === 'trial' && r.trialId === trialId)
    const tx = records.find((r) => r.k === 'wire' && r.dir === 'toDevice' && r.trialId === trialId)
    const feedback = records.find(
        (r) => r.trialId === trialId && fields(r).some(({ t, v }) => t === trial.tag && v === trial.value),
    )
    assert.ok(tx && feedback)
    const [property, payload] = target(trial)
    const previous = { ...state }
    const count = sent.length
    Connection.prototype.received.call(ha, `rethink/${id}/${property}/set`, Buffer.from(payload), { retain: false })
    assert.equal(sent.length, count + 1)
    assert.equal(sent[count].toString('hex'), tx.hex.toLowerCase())
    assert.deepEqual(state, previous)
    device.emit('data', Buffer.from('0201040000008701100000ec3c', 'hex'))
    assert.deepEqual(state, previous)
    device.emit('data', Buffer.from(feedback.hex, 'hex'))
    assert.equal(state[property], property === 'timer_minutes' ? Number(payload) : payload)
    assert.equal(sent.length, count + 1)
    if (property === 'fan_speed' && payload === 'Auto') assert.equal(state.fan_speed_raw, 8)
}
assert.equal(sent.length, 24)
device.emit('close')
assert.equal(state.availability, 'offline')
assert.equal(device.listenerCount('data'), 0)
Connection.prototype.received.call(ha, `rethink/${id}/power/set`, Buffer.from('ON'), { retain: false })
assert.equal(sent.length, 24)
console.log('Native image: all 24 captured writes, corrected labels, feedback and MQTT routing passed OFFLINE')
