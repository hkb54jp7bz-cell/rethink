import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Bridge from '@/cloud/ha_bridge'
import { Connection } from '@/cloud/homeassistant'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import type { IPublishPacket } from 'mqtt'

const examples = JSON.parse(
    readFileSync(new URL('../../docs/examples/homebridge-puricare.json', import.meta.url), 'utf8'),
)
const evidence = readFileSync(new URL('../fixtures/puricare/puricare-control-tests.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
const ID = '18e271fb-81d6-45dd-818c-3034db55eb63'
const base = `rethink/${ID}`
// MQTT-Thing's documented apply(message, state) API; all functions are our example
// configuration, never expressions taken from an appliance packet or user log.
function apply(topic: any, message: string | number, state: any = { global: {} }) {
    return typeof topic === 'string' ? message : new Function('message', 'state', topic.apply)(message, state)
}
function rig(t: import('node:test').TestContext) {
    const ha = new MockHAConnection()
    Object.assign(ha, { config: { rethink_prefix: 'rethink', discovery_prefix: 'homeassistant' } })
    const thinq = new MockThinq2Device(ID, { modelId: 'AIR_910604_WW', modelName: 'AS651DWH0' })
    const bridge = new Bridge(ha.asConnection())
    bridge.newDevice(thinq)
    t.after(() => thinq.emit('close'))
    return {
        thinq,
        send(topic: any, message: string | number, trialId: number, state = { global: {} }) {
            const value = apply(topic, message, state)
            assert.notEqual(value, undefined)
            const name = typeof topic === 'string' ? topic : topic.topic
            Connection.prototype.received.call(ha.asConnection(), name, Buffer.from(String(value)), {
                retain: false,
            } as IPublishPacket)
            const trial = evidence.find((r) => r.k === 'trial' && r.trialId === trialId)
            assert.equal(thinq.outbox[thinq.outbox.length - 1].toString('hex').toUpperCase(), trial.packet)
        },
    }
}

test('Homebridge example is additive, contains no retained/startup commands or invented air-quality data', () => {
    assert.equal(examples.length, 14)
    for (const accessory of examples) {
        assert.equal(accessory.accessory, 'mqttthing')
        assert.equal(accessory.url, 'mqtt://127.0.0.1:1883')
        assert.equal(accessory.mqttPubOptions.retain, false)
        assert.equal(accessory.confirmationIndicateOffline, false)
        assert.equal(accessory.logMqtt, false)
        assert.equal(accessory.optimizePublishing, false)
        assert.equal(accessory.startPub, undefined)
        assert.equal(accessory.username, undefined)
        assert.equal(accessory.password, undefined)
        for (const key of Object.keys(accessory.topics))
            assert.doesNotMatch(key, /AirQuality|PM10|PM2|Humidity|Temperature|FilterLife/)
    }
    assert.equal(examples[0].type, 'airPurifier')
    assert.equal(examples[0].topics.getOnline, `${base}/availability`)
    assert.deepEqual(
        examples[0],
        JSON.parse(
            readFileSync(new URL('../../docs/examples/homebridge-puricare-principal.json', import.meta.url), 'utf8'),
        ),
    )
})

test('manual slider is four UI positions; Auto is a separate target and never maximum speed', (t) => {
    const { send, thinq } = rig(t)
    const config = examples[0]
    const state = { global: {} }
    for (const [value, position, trial] of [
        ['2', 25, 8],
        ['4', 50, 9],
        ['6', 75, 10],
        ['7', 100, 11],
    ] as const) {
        assert.equal(apply(config.topics.getRotationSpeed, value, state), position)
        send(config.topics.setRotationSpeed, position, trial, state)
    }
    assert.equal(apply(config.topics.getRotationSpeed, 'Auto', state), undefined)
    assert.equal(apply(config.topics.getTargetAirPurifierState, 'Auto', state), 'AUTO')
    send(config.topics.setTargetAirPurifierState, 'AUTO', 12, state)
    send(config.topics.setTargetAirPurifierState, 'MANUAL', 11, state)
    send(config.topics.setTargetAirPurifierState, 'MANUAL', 8)
    assert.equal(apply(config.topics.getTargetAirPurifierState, '2'), 'MANUAL')
    for (const invalid of [0, -1, 101, 'NaN']) assert.equal(apply(config.topics.setRotationSpeed, invalid), undefined)
    assert.equal(apply(config.topics.getRotationSpeed, '8'), undefined)
    assert.equal(thinq.outbox.length, 7)
})

test('HomeKit power, physical mode switches, swing and light generate only captured commands', (t) => {
    const { send, thinq } = rig(t)
    const main = examples[0],
        smart = examples[1],
        booster = examples[2],
        light = examples[3]
    assert.equal(smart.onValue, 'Smart')
    assert.equal(smart.offValue, 'Normal')
    assert.equal(smart.otherValueOff, true)
    assert.equal(booster.onValue, 'Booster')
    assert.equal(booster.offValue, 'Normal')
    send(main.topics.setActive, main.offValue, 1)
    send(main.topics.setActive, main.onValue, 2)
    send(smart.topics.setOn, smart.onValue, 5)
    send(smart.topics.setOn, smart.offValue, 6)
    send(booster.topics.setOn, booster.onValue, 7)
    send(main.topics.setSwingMode, main.swingModeValues[0], 18)
    send(main.topics.setSwingMode, main.swingModeValues[1], 19)
    send(light.topics.setOn, light.offValue, 20)
    send(light.topics.setOn, light.onValue, 21)
    assert.equal(apply(main.topics.getCurrentAirPurifierState, 'OFF'), 'INACTIVE')
    assert.equal(apply(main.topics.getCurrentAirPurifierState, 'ON'), 'PURIFYING')
    assert.equal(thinq.outbox.length, 9)
})

test('booster and timer preset buttons send one captured request and their UI reset sends nothing', (t) => {
    const { send, thinq } = rig(t)
    const trials = [13, 14, 15, 16, 17, 23, 24, 25, 26, 27]
    for (const [index, accessory] of examples.slice(4).entries()) {
        assert.equal(accessory.turnOffAfterms, 1000)
        assert.equal(accessory.topics.getOn, undefined)
        send(accessory.topics.setOn, 'ON', trials[index])
        assert.equal(apply(accessory.topics.setOn, 'OFF'), undefined)
    }
    assert.equal(thinq.outbox.length, 10)
    assert.equal(examples[4].topics.setOn.topic, `${base}/booster_speed/set`)
    assert.equal(examples[13].topics.setOn.topic, `${base}/timer_minutes/set`)
})
