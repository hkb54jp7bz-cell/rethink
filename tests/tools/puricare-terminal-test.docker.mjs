import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'
import * as TLV from './dist/util/tlv.js'
import crc16 from './dist/util/crc16.js'
const script = '/app/tools/puricare-terminal-test.mjs'
const id = '18e271fb-81d6-45dd-818c-3034db55eb63'
const tests = [
    ['energia OFF', 0x1f7, 0],
    ['energia ON', 0x1f7, 1],
    ...[
        ['Normal', 16],
        ['Smart', 13],
        ['Booster', 14],
    ].map(([n, v]) => ['modo ' + n, 0x1f9, v]),
    ...[2, 4, 6, 7, 8].map((v) => ['fan ' + v, 0x1fa, v]),
    ...[2, 4, 6, 7, 8].map((v) => ['booster ' + v, 0x326, v]),
    ...[0, 1].map((v) => ['oscilacao ' + v, 0x327, v]),
    ['luz OFF', 0x24e, 0],
    ['luz ON', 0x24e, 1],
    ...[120, 240, 480, 720, 0].map((v) => ['timer ' + v, 0x21a, v]),
]
for (const kind of ['all-controls', 'wrong-model', 'offline', 'dry-run']) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 44401 })
    await new Promise((r) => server.once('listening', r))
    let connections = 0,
        sends = 0,
        start = false,
        index = 0,
        buffer = '',
        stdout = '',
        stderr = ''
    const child = spawn(process.execPath, [script, ...(kind === 'dry-run' ? [] : ['--execute'])], {
        cwd: '/app',
        stdio: ['pipe', 'pipe', 'pipe'],
    })
    const deadline = setTimeout(() => {
        console.error('DEBUG', { stdout: stdout.slice(-4000), stderr, sends, index, start })
        child.kill()
        throw new Error('Mock test timed out: ' + kind)
    }, 20000)
    server.on('connection', (ws, req) => {
        connections++
        assert.equal(new URL(req.url, 'http://localhost').searchParams.get('id'), id)
        ws.on('message', (data) => {
            assert.equal(kind, 'all-controls')
            const msg = JSON.parse(data.toString())
            const packet = Buffer.from(msg.sendToDevice, 'hex')
            assert.deepEqual(Object.keys(msg), ['sendToDevice'])
            assert.equal(crc16(packet.subarray(2)), 0)
            assert.equal(packet.subarray(0, 10).toString('hex'), '01010400000065020101')
            assert.deepEqual(
                TLV.parse(packet.subarray(11, -2)).map(({ t, v }) => [t, v]),
                [[tests[index][1], tests[index][2]]],
            )
            sends++
            ws.send(JSON.stringify({ tx: msg.sendToDevice, injected: true, type: 'packet' }))
            // Test that no second command can be sent while a physical result is pending.
            if (index === 0) child.stdin.write('energia ON\n')
            const body = TLV.build([{ t: tests[index][1], v: tests[index][2] }])
            const bytes = [4, 0, 0, 0, 0xa7, 2, 4, index, body.length, ...body]
            const crc = crc16(bytes)
            const hex = Buffer.from([0, 0, ...bytes, crc >> 8, crc & 255]).toString('hex')
            ws.send(JSON.stringify({ rx: hex, type: 'packet', injected: false }))
        })
        ws.send(
            JSON.stringify(
                kind === 'offline'
                    ? { status: 'offline' }
                    : {
                          status: 'online',
                          meta: { modelId: kind === 'wrong-model' ? 'RAC_056905_WW' : 'AIR_910604_WW' },
                      },
            ),
        )
    })
    child.stderr.on('data', (s) => (stderr += s))
    child.stdout.on('data', (chunk) => {
        stdout += chunk
        buffer += chunk
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (kind === 'all-controls' && !start && line.includes('PRONTO.')) {
                start = true
                child.stdin.write(
                    'fan 3\nbooster 100\ntimer 60\nmodo invalid\nenergia on extra\nconstructor on\n0x333 1\n' +
                        tests[0][0] +
                        '\n',
                )
            }
            if (kind === 'all-controls' && line.includes('RETORNO:')) {
                index++
                child.stdin.write('ok\n' + (index < tests.length ? tests[index][0] : 'sair') + '\n')
            }
        }
    })
    const code = await new Promise((r) => child.on('exit', r))
    clearTimeout(deadline)
    assert.equal(code, kind === 'wrong-model' || kind === 'offline' ? 1 : 0, stderr)
    assert.equal(sends, kind === 'all-controls' ? tests.length : 0)
    assert.equal(connections, kind === 'dry-run' ? 0 : 1)
    if (kind === 'all-controls') {
        const path = stdout.match(/CAPTURA: (\/tmp\/puricare-testes-\d+\.jsonl)/)[1]
        const records = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse)
        const outcomes = records.filter((r) => r.k === 'result')
        assert.equal(outcomes.length, tests.length)
        assert.ok(outcomes.every((r) => r.physicalChange === true && r.matchingResponse && r.txObserved))
        assert.equal(records.filter((r) => r.k === 'wire' && r.dir === 'toDevice').length, tests.length)
        assert.equal(records.filter((r) => r.k === 'wire' && r.dir === 'fromDevice').length, tests.length)
        assert.match(stdout, /Confirme o teste anterior/)
    }
    await new Promise((r) => server.close(r))
    console.log('OFFLINE mock ' + kind + ': passed (' + sends + ' mocked sends)')
}
