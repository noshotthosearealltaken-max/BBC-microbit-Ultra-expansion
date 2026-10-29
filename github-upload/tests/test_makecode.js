'use strict';

// Uses the TypeScript compiler from the local MakeCode toolchain.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

class MicrobitBuffer extends Uint8Array {
    slice(offset = 0, length = this.length - offset) {
        return new MicrobitBuffer(super.slice(offset, offset + length));
    }
    toString() { return Buffer.from(this).toString('utf8'); }
}

const sent = [];
const groups = [];
const radio = {
    setGroup: group => groups.push(group),
    onReceivedBuffer: handler => { radio.handler = handler; },
    sendBuffer: packet => sent.push(packet),
    receivedSignalStrength: () => -60
};
const control = {
    createBuffer: length => new MicrobitBuffer(length),
    createBufferFromUTF8: text => new MicrobitBuffer(Buffer.from(text, 'utf8'))
};
const pins = { analogWritePin() {}, digitalWritePin() {}, servoWritePin() {} };
const AnalogPin = { P13: 13, P15: 15 };
const DigitalPin = { P14: 14, P16: 16 };
const source = fs.readFileSync('ultra.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2017 } }).outputText;
const context = vm.createContext({ radio, control, pins, AnalogPin, DigitalPin,
    CompareOp: { Greater: 0, Less: 1, Equal: 2, Contains: 3 },
    MathOp: { Add: 0, Subtract: 1, Multiply: 2, Divide: 3 } });
vm.runInContext(js, context);
const ultra = context.ultra;

ultra.setRadioGroup(7);
assert.deepEqual(groups, [7]);
ultra.setRadioGroup(8);
assert.deepEqual(groups, [7, 8]);

const payload = ultra.packText(ultra.KIND_TEXT, 'hello', 1);
assert.equal(ultra.unpack(payload).text, 'hello');
assert.equal(ultra.unpack(payload).payload.length, 5);
let received = 0;
let above = 0;
ultra.onAny(() => received++);
ultra.onSignalAbove(-70, () => above++);
ultra.handleMessage(ultra.packText(ultra.KIND_TEXT, 'other board', 2), -60);
assert.equal(received, 0);
assert.equal(ultra.lastText(), '');
ultra.handleMessage(payload, -70);
assert.equal(received, 1);
assert.equal(above, 0);
ultra.handleMessage(payload, -69);
assert.equal(above, 1);
ultra.handleMessage(ultra.packText(ultra.KIND_TEXT, 'broadcast', 255), -60);
assert.equal(received, 3);

ultra.sendCall('drive', '', '180', '');
const call = ultra.unpack(sent.pop());
assert.equal(call.name, 'drive');
assert.deepEqual(Array.from(call.args), ['', '180']);

const oversized = control.createBuffer(32);
oversized[0] = ultra.MAGIC;
oversized[1] = ultra.VERSION << 4;
oversized[5] = 25;
oversized[31] = ultra.checksum(oversized, 31);
assert.equal(ultra.unpack(oversized), null);
console.log('MakeCode runtime regression checks passed');
