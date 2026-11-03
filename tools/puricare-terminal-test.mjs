#!/usr/bin/env node
// Experimental, interactive probe for AS651DWH0 firmware 371. These are candidate
// writes derived from observed READ values, not validated native control support.
// No appliance packets are sent until --execute AND a valid menu command are given.
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const deviceId = '18e271fb-81d6-45dd-818c-3034db55eb63'
const definitions = {
    energia: [0x1f7, { on: 1, off: 0 }],
    modo: [0x1f9, { normal: 16, smart: 13, booster: 14 }],
    fan: [0x1fa, [2, 4, 6, 7, 8]],
    booster: [0x326, [2, 4, 6, 7, 8]],
    oscilacao: [0x327, [0, 1]],
    luz: [0x24e, { on: 1, off: 0 }],
    timer: [0x21a, [0, 120, 240, 480, 720]],
}
const help = `TESTES EXPERIMENTAIS — somente PuriCare ${deviceId}
energia ON|OFF
modo Normal|Smart|Booster
fan 2|4|6|7|8
booster 2|4|6|7|8
oscilacao 0|1
luz ON|OFF
timer 0|120|240|480|720

Depois de cada envio, observe o aparelho e digite:
ok  = a alteracao fisica aconteceu; nao = nao aconteceu.
Use um valor diferente do atual. O retorno MQTT sozinho nao comprova a mudanca.
Use modo Booster antes de testar booster/oscilacao; se preciso, selecione no painel.
Ao testar o timer, termine com timer 0 e confira o cancelamento no aparelho.
estado = ultimos valores recebidos (nao envia consulta); ajuda = menu; sair = encerrar.
Campos ambientais sao apenas lidos. Nao ha reenvio, polling ou restauracao automatica.`

console.log(help)
if (process.argv.length !== 3 || process.argv[2] !== '--execute') {
    console.log(
        '\nNa imagem com o menu instalado: puricare-testes. No script avulso: node /tmp/puricare-testes.mjs --execute',
    )
    process.exit(0)
}

const { default: WebSocket } = await import('/app/node_modules/ws/wrapper.mjs')
const { default: crc16 } = await import('/app/dist/util/crc16.js')
const TLV = await import('/app/dist/util/tlv.js')
const path = `/tmp/puricare-testes-${Date.now()}.jsonl`
writeFileSync(path, '', { flag: 'wx', mode: 0o600 })
function record(event) {
    const entry = { ts: Date.now(), ...event }
    appendFileSync(path, JSON.stringify(entry) + '\n')
    console.log(JSON.stringify(entry))
}
record({ k: 'session', v: 1, tool: 'puricare-terminal-test/1', deviceId, experimental: true })
const ws = new WebSocket(`ws://127.0.0.1:44401/device?id=${deviceId}`, { handshakeTimeout: 5000 })
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'puricare> ' })
const latest = new Map()
let ready = false
let ended = false
let pending
let serial = 0
const startup = setTimeout(() => finish('Sem confirmacao do modelo em 10 segundos', 1), 10000)

function finish(reason, code = 0) {
    if (ended) return
    ended = true
    clearTimeout(startup)
    if (pending) record({ k: 'result', ...pending, physicalChange: null, outcome: 'unconfirmed' })
    record({ k: 'marker', phase: 'stopped', reason })
    console.log(`CAPTURA: ${path}\nPara copiar o resultado: cat ${path}`)
    process.exitCode = code
    rl.close()
    process.stdin.pause()
    process.stdin.unref?.()
    ws.terminate()
}
function parseNotification(hex) {
    if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return []
    const b = Buffer.from(hex, 'hex')
    if (
        b.length < 13 ||
        b.subarray(0, 9).toString('hex') !== '000004000000a70204' ||
        b[10] !== b.length - 13 ||
        crc16(b.subarray(2)) !== 0
    )
        return []
    const body = b.subarray(11, -2)
    for (let i = 0; i < body.length; ) {
        if (i + 2 > body.length) return []
        const size = 2 + ((body[i + 1] >> 4) & 3)
        if (i + size > body.length) return []
        i += size
    }
    return TLV.parse(body)
}
ws.on('message', (data) => {
    if (ended) return
    let message
    try {
        message = JSON.parse(data.toString())
    } catch {
        return
    }
    if (message.status) {
        record({ k: 'marker', phase: message.status, meta: message.meta })
        if (message.status === 'offline') return finish('PuriCare offline', 1)
        if (message.status === 'online') {
            if (message.meta?.modelId !== 'AIR_910604_WW')
                return finish('Modelo diferente: nenhum novo envio permitido', 1)
            ready = true
            clearTimeout(startup)
            console.log('PRONTO. Digite um comando do menu; nenhum comando foi enviado automaticamente.')
            rl.prompt()
        }
    }
    for (const [key, dir] of [
        ['tx', 'toDevice'],
        ['rx', 'fromDevice'],
    ]) {
        if (typeof message[key] !== 'string') continue
        record({
            k: 'wire',
            dir,
            type: message.type ?? 'packet',
            injected: !!message.injected,
            hex: message[key],
            trialId: pending?.trialId,
        })
        if (pending && key === 'tx' && message[key].toLowerCase() === pending.packet.toLowerCase())
            pending.txObserved = true
        if (key !== 'rx' || message.injected || message.type === 'ack') continue
        for (const { t, v } of parseNotification(message[key])) {
            latest.set(t, v)
            if (pending && t === pending.tag && v === pending.value) {
                pending.matchingResponse = true
                console.log(`RETORNO: 0x${t.toString(16)}=${v}; confirme a mudanca fisica com ok ou nao.`)
            }
        }
    }
})
rl.on('line', (input) => {
    if (ended) return
    const words = input.trim().toLowerCase().split(/\s+/)
    const [command, arg] = words
    if (!command) return rl.prompt()
    if (command === 'sair') return finish('Encerrado pelo usuario')
    if (command === 'ajuda') {
        console.log(help)
        return rl.prompt()
    }
    if (command === 'estado') {
        console.log(Object.fromEntries([...latest].map(([t, v]) => [`0x${t.toString(16)}`, v])))
        return rl.prompt()
    }
    if (['ok', 'nao', 'não'].includes(command)) {
        if (!pending) console.log('Nenhum teste pendente.')
        else {
            record({ k: 'result', ...pending, physicalChange: command === 'ok', note: input })
            pending = undefined
        }
        return rl.prompt()
    }
    if (!ready || ws.readyState !== WebSocket.OPEN) {
        console.log('Aguarde a confirmacao do modelo.')
        return rl.prompt()
    }
    if (pending) {
        console.log('Confirme o teste anterior com ok ou nao antes de outro envio.')
        return rl.prompt()
    }
    const definition = Object.hasOwn(definitions, command) ? definitions[command] : undefined
    let value
    if (definition && words.length === 2) {
        const allowed = definition[1]
        value = Array.isArray(allowed)
            ? /^\d+$/.test(arg) && allowed.includes(Number(arg))
                ? Number(arg)
                : undefined
            : Object.hasOwn(allowed, arg)
              ? allowed[arg]
              : undefined
    }
    if (value === undefined) {
        console.log('Comando/valor invalido; veja ajuda. Nada enviado.')
        return rl.prompt()
    }
    const tag = definition[0]
    const body = TLV.build([{ t: tag, v: value }])
    const bytes = [4, 0, 0, 0, 0x65, 2, 1, 1, body.length, ...body]
    const crc = crc16(bytes)
    const packet = Buffer.from([1, 1, ...bytes, crc >> 8, crc & 255])
        .toString('hex')
        .toUpperCase()
    pending = {
        trialId: ++serial,
        command: input,
        tag,
        value,
        previousValue: latest.get(tag) ?? null,
        packet,
        txObserved: false,
        matchingResponse: false,
    }
    record({ k: 'trial', ...pending })
    ws.send(JSON.stringify({ sendToDevice: packet }), (error) => {
        if (error) finish('Falha no envio: ' + error.message, 1)
    })
    console.log('Uma tentativa enviada. Observe o aparelho; digite ok ou nao. Nenhum reenvio automatico.')
    rl.prompt()
})
ws.on('error', (error) => finish('Erro: ' + error.message, 1))
ws.on('close', () => finish('Conexao encerrada', 1))
rl.on('close', () => finish('Entrada encerrada'))
process.on('SIGINT', () => finish('Interrompido pelo usuario'))
