/**
 * Tests for js/ultra.js, run with Node:
 *
 *     node tests/test_ultra_js.js
 *
 * The MakeCode micro:bit APIs (radio, pins, music, control, basic) are
 * replaced by recording fakes, and the runtime is evaluated inside a fresh
 * VM context for every test so module state never leaks between cases.
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RUNTIME = path.join(__dirname, '..', 'js', 'ultra.js');
const SOURCE = fs.readFileSync(RUNTIME, 'utf8');

class ByteBuffer extends Uint8Array {
    toString() {
        return Buffer.from(this).toString('utf8');
    }
}

const AnalogPin = { P0: 0, P1: 1, P2: 2, P8: 8, P13: 13, P14: 14, P15: 15, P16: 16 };
const DigitalPin = { P0: 0, P1: 1, P2: 2, P8: 8, P13: 13, P14: 14, P15: 15, P16: 16 };

function makeWorld() {
    const world = {
        sent: [],
        pwm: [],
        digital: [],
        servo: [],
        pitches: [],
        paused: 0,
        melodiesPlayed: []
    };

    const radio = {
        group: null,
        handlers: [],
        rssi: -60,
        setGroup(group) {
            this.group = group;
        },
        sendBuffer(buffer) {
            world.sent.push(Array.from(buffer));
        },
        onReceivedBuffer(handler) {
            this.handlers.push(handler);
        },
        receivedSignalStrength() {
            return this.rssi;
        },
        deliver(bytes, rssi) {
            this.rssi = rssi === undefined ? -60 : rssi;
            for (const handler of this.handlers) {
                handler(new ByteBuffer(bytes));
            }
        }
    };

    const pins = {
        analogWritePin(pin, value) {
            world.pwm.push([pin, value]);
        },
        digitalWritePin(pin, value) {
            world.digital.push([pin, value]);
        },
        servoWritePin(pin, angle) {
            world.servo.push([pin, angle]);
        },
        analogPitch(frequency, ms) {
            world.pitches.push([frequency, ms]);
        }
    };

    const music = {
        playMelody(notes, tempo) {
            world.melodiesPlayed.push([notes, tempo]);
        },
        playTone() {},
        stopAllSounds() {}
    };

    const basic = {
        pause(ms) {
            world.paused += ms;
        }
    };

    const control = {
        createBuffer(size) {
            return new ByteBuffer(size);
        },
        createBufferFromUTF8(text) {
            return new ByteBuffer(Buffer.from(text, 'utf8'));
        }
    };

    // Evaluate in the host realm so arrays and objects compare cleanly with
    // deepStrictEqual, and so every test gets brand new module state.
    const load = new Function('radio', 'pins', 'music', 'basic', 'control',
        'AnalogPin', 'DigitalPin', SOURCE + '\nreturn ultra;');
    const ultra = load(radio, pins, music, basic, control, AnalogPin, DigitalPin);

    return { ultra, radio, world };
}

function packetFrom(ultraApi, senderId, text, kind) {
    ultraApi.setId(senderId);
    const packet = ultraApi.packText(kind === undefined ? ultraApi.KIND_TEXT : kind, text, undefined);
    ultraApi.setId(1);
    return Array.from(packet);
}

function lastFor(entries, index) {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i][0] === index) return entries[i][1];
    }
    return undefined;
}

const tests = [];
function test(name, fn) {
    tests.push([name, fn]);
}

// ---------------------------------------------------------------------
// protocol
// ---------------------------------------------------------------------

test('packs a text packet with the documented header and checksum', () => {
    const { ultra, world } = makeWorld();
    ultra.start(1);
    ultra.sendMessage('hello', 9);
    assert.strictEqual(world.sent.length, 1);
    assert.deepStrictEqual(world.sent[0],
        [0xE7, 0x10, 1, 9, 0, 5, 104, 101, 108, 108, 111, 0x98]);
});

test('parses a packet back into a message', () => {
    const { ultra } = makeWorld();
    const bytes = packetFrom(ultra, 1, 'hello', ultra.KIND_TEXT);
    const message = ultra.parse(new ByteBuffer(bytes));
    assert.strictEqual(message.text, 'hello');
    assert.strictEqual(message.sender, 1);
    assert.strictEqual(message.destination, 255);
    assert.strictEqual(message.kind, ultra.KIND_TEXT);
});

test('omitting the destination broadcasts', () => {
    const { ultra, world } = makeWorld();
    ultra.sendMessage('anyone');
    assert.strictEqual(world.sent[0][3], 255);
});

test('clamps the payload to 24 bytes', () => {
    const { ultra, world } = makeWorld();
    ultra.sendMessage('x'.repeat(40));
    assert.strictEqual(world.sent[0][5], 24);
    assert.strictEqual(world.sent[0].length, 31);
    assert.strictEqual(ultra.parse(new ByteBuffer(world.sent[0])).text, 'x'.repeat(24));
});

test('rejects corrupt, truncated and foreign packets', () => {
    const { ultra } = makeWorld();
    const bytes = packetFrom(ultra, 1, 'hello');
    const corrupt = bytes.slice(0);
    corrupt[corrupt.length - 1] ^= 0xff;
    assert.strictEqual(ultra.parse(new ByteBuffer(corrupt)), null);
    assert.strictEqual(ultra.parse(new ByteBuffer([0x00, 0x01])), null);
    assert.strictEqual(ultra.parse(new ByteBuffer([0xE7, 0x20, 1, 0, 0, 0, 0])), null);
    assert.strictEqual(ultra.parse(null), null);
});

// ---------------------------------------------------------------------
// features 2-5: filters
// ---------------------------------------------------------------------

test('sender filter accepts listed boards and blocks others', () => {
    const { ultra } = makeWorld();
    ultra.start(1);
    ultra.setSenderFilter([2]);
    assert.strictEqual(ultra.handle(new ByteBuffer(packetFrom(ultra, 1, 'nope')), -60), null);
    const accepted = ultra.handle(new ByteBuffer(packetFrom(ultra, 2, 'yes')), -60);
    assert.strictEqual(accepted.text, 'yes');
    ultra.clearSenderFilter();
    assert.ok(ultra.handle(new ByteBuffer(packetFrom(ultra, 7, 'any')), -60));
});

test('signal threshold drops weak packets', () => {
    const { ultra } = makeWorld();
    ultra.setSignalThreshold(-70);
    const bytes = packetFrom(ultra, 5, 'x');
    assert.strictEqual(ultra.handle(new ByteBuffer(bytes), -90), null);
    const strong = ultra.handle(new ByteBuffer(bytes), -55);
    assert.strictEqual(strong.rssi, -55);
    assert.strictEqual(ultra.lastRssi(), -55);
    assert.strictEqual(ultra.signalStrength(), -60);
});

test('signal handler only fires above its level', () => {
    const { ultra } = makeWorld();
    const seen = [];
    ultra.onSignalAbove(-70, (message) => seen.push(message.rssi));
    const bytes = packetFrom(ultra, 5, 'x');
    ultra.handle(new ByteBuffer(bytes), -80);
    ultra.handle(new ByteBuffer(bytes), -50);
    assert.deepStrictEqual(seen, [-50]);
});

test('content filter and content handler', () => {
    const { ultra } = makeWorld();
    ultra.setContentFilter('go');
    assert.strictEqual(ultra.handle(new ByteBuffer(packetFrom(ultra, 5, 'stop')), -60), null);
    assert.ok(ultra.handle(new ByteBuffer(packetFrom(ultra, 5, 'go now')), -60));
    ultra.setContentFilter('');

    const seen = [];
    ultra.onContent('LED', (message) => seen.push(message.text));
    ultra.handle(new ByteBuffer(packetFrom(ultra, 5, 'LED on')), -60);
    ultra.handle(new ByteBuffer(packetFrom(ultra, 5, 'off')), -60);
    assert.deepStrictEqual(seen, ['LED on']);
});

test('sender handler receives only that board', () => {
    const { ultra } = makeWorld();
    const seen = [];
    ultra.onSender(4, (message) => seen.push(message.sender));
    ultra.handle(new ByteBuffer(packetFrom(ultra, 4, 'a')), -60);
    ultra.handle(new ByteBuffer(packetFrom(ultra, 5, 'b')), -60);
    assert.deepStrictEqual(seen, [4]);
});

// ---------------------------------------------------------------------
// features 6-8: command codes and serialised calls
// ---------------------------------------------------------------------

test('command codes are sent, decoded and dispatched', () => {
    const { ultra, world } = makeWorld();
    ultra.start(1);
    ultra.defineCommand(101, 'turn left');
    const seen = [];
    ultra.onCommand(101, (message) => seen.push(message.code));

    ultra.sendCommand(101, 4);
    assert.strictEqual(world.sent[0][1], 0x11);
    const outgoing = ultra.parse(new ByteBuffer(world.sent[0]));
    assert.strictEqual(outgoing.code, 101);
    assert.strictEqual(outgoing.text, 'turn left');

    const incoming = ultra.handle(new ByteBuffer(packetFrom(ultra, 9, '101', ultra.KIND_CODE)), -60);
    assert.strictEqual(incoming.text, 'turn left');
    assert.strictEqual(ultra.lastSignal(), 101);
    assert.deepStrictEqual(seen, [101]);
    assert.strictEqual(ultra.decodeCommand(101), 'turn left');
    assert.strictEqual(ultra.decodeCommand(999), 'unknown (999)');
});

test('call encoding escapes separators and re-types arguments', () => {
    const { ultra } = makeWorld();
    assert.strictEqual(ultra.encodeCall('drive', [200, -200]), 'drive|200|-200');
    assert.strictEqual(ultra.encodeCall('say', ['a|b', 'c\\d']), 'say|a\\|b|c\\\\d');
    const call = ultra.decodeCall('drive|200|-200');
    assert.strictEqual(call.name, 'drive');
    assert.deepStrictEqual(call.args, [200, -200]);
    const typed = ultra.decodeCall('f|1|2.5|hi|True');
    assert.deepStrictEqual(typed.args, [1, 2.5, 'hi', true]);
    const escaped = ultra.decodeCall('say|a\\|b|c\\\\d');
    assert.deepStrictEqual(escaped.args, ['a|b', 'c\\d']);
});

test('incoming calls invoke registered functions', () => {
    const { ultra } = makeWorld();
    const seen = [];
    ultra.registerFunction('beep', (times) => seen.push(times));
    const bytes = packetFrom(ultra, 3, ultra.encodeCall('beep', [4]), ultra.KIND_CALL);
    const message = ultra.handle(new ByteBuffer(bytes), -60);
    assert.deepStrictEqual(seen, [4]);
    assert.strictEqual(message.name, 'beep');
    assert.deepStrictEqual(ultra.lastCallArguments(), [4]);
});

test('handler errors are captured, not thrown', () => {
    const { ultra } = makeWorld();
    ultra.registerFunction('boom', () => {
        throw new Error('boom');
    });
    ultra.handle(new ByteBuffer(packetFrom(ultra, 3, 'boom', ultra.KIND_CALL)), -60);
    assert.strictEqual(ultra.lastError().message, 'boom');
});

test('sendCall targets a board and carries arguments', () => {
    const { ultra, world } = makeWorld();
    ultra.sendCall('wave', [45], 2);
    const outgoing = ultra.parse(new ByteBuffer(world.sent[0]));
    assert.strictEqual(outgoing.name, 'wave');
    assert.deepStrictEqual(outgoing.args, [45]);
    assert.strictEqual(outgoing.destination, 2);
});

// ---------------------------------------------------------------------
// features 9-14: variables and objects
// ---------------------------------------------------------------------

test('unpack takes values with padding', () => {
    const { ultra } = makeWorld();
    assert.deepStrictEqual(ultra.unpack([1, 2, 3], 3), [1, 2, 3]);
    assert.deepStrictEqual(ultra.unpack([1], 3), [1, null, null]);
    assert.deepStrictEqual(ultra.unpack([1], 2, 0), [1, 0]);
});

test('setVariables stores named values', () => {
    const { ultra } = makeWorld();
    ultra.setVariables('x, y, z', [4, 5, 6]);
    assert.strictEqual(ultra.variables.get('x'), 4);
    assert.strictEqual(ultra.variables.get('z'), 6);
    assert.ok(ultra.variables.has('y'));
});

test('variablesFromKeys handles pairs, plain arrays and objects', () => {
    const { ultra } = makeWorld();
    ultra.variablesFromKeys([['speed', 120], ['mode', 'auto']]);
    assert.strictEqual(ultra.variables.get('speed'), 120);
    assert.strictEqual(ultra.variables.get('mode'), 'auto');

    ultra.variablesFromKeys([10, 20]);
    assert.strictEqual(ultra.variables.get(0), 10);
    assert.strictEqual(ultra.variables.get('1'), 20);

    ultra.variablesFromKeys({ lives: 3 });
    assert.strictEqual(ultra.variables.get('lives'), 3);
});

test('arrayToObject produces named properties', () => {
    const { ultra } = makeWorld();
    const player = ultra.arrayToObject([100, 3, 'sam'], 'score, lives, name');
    assert.deepStrictEqual(player, { score: 100, lives: 3, name: 'sam' });
    const paired = ultra.arrayToObject([['x', 1], ['y', 2]]);
    assert.deepStrictEqual(paired, { x: 1, y: 2 });
    const defaulted = ultra.arrayToObject([7, 8]);
    assert.deepStrictEqual(defaulted, { item0: 7, item1: 8 });
});

test('resetVariable picks a default per type', () => {
    const { ultra } = makeWorld();
    ultra.variables.set('count', 12);
    ultra.variables.set('label', 'hi');
    ultra.variables.set('items', [1, 2]);
    assert.strictEqual(ultra.resetVariable('count'), 0);
    assert.strictEqual(ultra.resetVariable('label'), '');
    assert.deepStrictEqual(ultra.resetVariable('items'), []);
    assert.strictEqual(ultra.resetVariable('count', 99), 99);
});

test('resetArray empties in place and clearVariables keeps named entries', () => {
    const { ultra } = makeWorld();
    const values = [1, 2, 3];
    assert.strictEqual(ultra.resetArray(values), values);
    assert.strictEqual(values.length, 0);

    ultra.variables.set('keep', 1);
    ultra.variables.set('drop', 2);
    ultra.clearVariables(['keep']);
    assert.strictEqual(ultra.variables.get('keep'), 1);
    assert.strictEqual(ultra.variables.has('drop'), false);
});

// ---------------------------------------------------------------------
// features 15-17: sorting, filtering, mapping
// ---------------------------------------------------------------------

test('sorting numbers, text and mixed arrays', () => {
    const { ultra } = makeWorld();
    assert.deepStrictEqual(ultra.sortArray([3, 1, 2]), [1, 2, 3]);
    assert.deepStrictEqual(ultra.sortArray([3, 1, 2], true), [3, 2, 1]);
    assert.deepStrictEqual(ultra.sortArray(['pear', 'apple']), ['apple', 'pear']);
    assert.deepStrictEqual(ultra.sortArray([2, 'a', 1]), [1, 2, 'a']);
});

test('sorting in place keeps the same array object', () => {
    const { ultra } = makeWorld();
    const values = [3, 1, 2];
    assert.strictEqual(ultra.sortArrayInPlace(values), values);
    assert.deepStrictEqual(values, [1, 2, 3]);
});

test('filtering and mapping leave the input alone', () => {
    const { ultra } = makeWorld();
    const values = [1, 2, 3, 4, 5];
    assert.deepStrictEqual(ultra.filterArray(values, ultra.greaterThan(2)), [3, 4, 5]);
    assert.deepStrictEqual(ultra.filterArray(values, ultra.isEven), [2, 4]);
    assert.deepStrictEqual(ultra.filterArray(values, ultra.between(2, 4)), [2, 3, 4]);
    assert.deepStrictEqual(ultra.filterArray(['alan', 'ada'], ultra.containsText('ad')), ['ada']);
    assert.deepStrictEqual(ultra.mapArray(values, ultra.multiplyBy(2)), [2, 4, 6, 8, 10]);
    assert.deepStrictEqual(values, [1, 2, 3, 4, 5]);
});

test('mapRange rescales and rounds down like the micro:bit PWM range', () => {
    const { ultra } = makeWorld();
    const scaled = ultra.mapArray([0, 512, 1023], ultra.mapRange(0, 1023, 0, 255));
    assert.deepStrictEqual(scaled.map(Math.floor), [0, 127, 255]);
});

// ---------------------------------------------------------------------
// feature 1: melodies
// ---------------------------------------------------------------------

test('decodes MB8 nibble deltas', () => {
    const { ultra } = makeWorld();
    const data = new ByteBuffer([0x4d, 0x42, 0x38, 0x01, 0x00, 0x9f]);
    assert.ok(ultra.isMb8(data));
    assert.deepStrictEqual(ultra.decodeMb8(data), [135, 136]);
    assert.strictEqual(ultra.isMb8(new ByteBuffer([0x4f, 0x67, 0x67, 0x53])), false);
});

test('rejects data that is not MB8', () => {
    const { ultra } = makeWorld();
    assert.throws(() => ultra.decodeMb8(new ByteBuffer([0x4f, 0x67, 0x67, 0x53])),
        /not MB8/);
    assert.throws(() => ultra.registerMelodyData('bad', [1, 2, 3]), /MB8/);
});

test('note melodies play through music.playMelody', () => {
    const { ultra, world } = makeWorld();
    ultra.registerMelody('startup', 'c5 e5 g5 c6', 150);
    assert.deepStrictEqual(ultra.melodyNames(), ['startup']);
    ultra.playMelody('startup');
    assert.deepStrictEqual(world.melodiesPlayed, [['c5 e5 g5 c6', 150]]);
    assert.strictEqual(ultra.melodyDuration('startup'), 0);
});

test('MB8 melodies play as pitched blocks and report a duration', () => {
    const { ultra, world } = makeWorld();
    const data = new ByteBuffer([0x4d, 0x42, 0x38, 0x01, 0x00].concat(new Array(300).fill(0xff)));
    ultra.registerMelodyData('tune', data);
    assert.ok(ultra.melodyDuration('tune') > 0);
    ultra.playMelody('tune');
    assert.ok(world.pitches.length > 0);
    assert.ok(world.pitches[0][0] > 0);
});

// ---------------------------------------------------------------------
// features 18-20: motors and servos
// ---------------------------------------------------------------------

test('motor speed maps 0-255 onto 0-1023', () => {
    const { ultra, world } = makeWorld();
    const motor = new ultra.Motor(13, 14);
    motor.setSpeed(255);
    assert.strictEqual(lastFor(world.pwm, 13), 1023);
    motor.setSpeed(128);
    assert.strictEqual(lastFor(world.pwm, 13), 513);
    motor.setSpeed(1000);
    assert.strictEqual(motor.speed(), 255);
});

test('motor direction and signed drive', () => {
    const { ultra, world } = makeWorld();
    const motor = new ultra.Motor(13, 14);
    motor.setDirection('forward');
    assert.strictEqual(lastFor(world.digital, 14), 1);
    motor.setDirection('backward');
    assert.strictEqual(lastFor(world.digital, 14), 0);
    motor.drive(-100);
    assert.strictEqual(lastFor(world.pwm, 13), 401);
    assert.strictEqual(lastFor(world.digital, 14), 0);
    motor.stop();
    assert.strictEqual(lastFor(world.pwm, 13), 0);
});

test('inverted motors flip the direction pin', () => {
    const { ultra, world } = makeWorld();
    const motor = new ultra.Motor(15, 16, true);
    motor.setDirection(true);
    assert.strictEqual(lastFor(world.digital, 16), 0);
    motor.brake();
    assert.strictEqual(lastFor(world.digital, 16), 1);
});

test('servo angles clamp and can move smoothly', () => {
    const { ultra, world } = makeWorld();
    const servo = new ultra.Servo(1, 180, 5);
    servo.setAngle(90, false);
    assert.strictEqual(servo.angle(), 90);
    assert.strictEqual(lastFor(world.servo, 1), 90);
    servo.setAngle(400, false);
    assert.strictEqual(servo.angle(), 180);
    servo.setAngle(0, true);
    assert.strictEqual(servo.angle(), 0);
    assert.ok(world.paused > 0);
    servo.center();
    assert.strictEqual(servo.angle(), 90);
});

test('dual motor movement and turns', () => {
    const { ultra, world } = makeWorld();
    ultra.configureMotorPins(13, 14, 15, 16);
    assert.deepStrictEqual(ultra.move(200, 180), [200, 180]);
    assert.strictEqual(lastFor(world.pwm, 13), 802);
    assert.strictEqual(lastFor(world.digital, 14), 1);
    assert.strictEqual(lastFor(world.digital, 16), 1);

    ultra.turnLeft(150);
    assert.strictEqual(lastFor(world.digital, 14), 0);
    assert.strictEqual(lastFor(world.digital, 16), 1);

    ultra.forward();
    assert.strictEqual(lastFor(world.pwm, 13), 1023);
    ultra.stopMotors();
    assert.strictEqual(lastFor(world.pwm, 15), 0);
});

test('movement without motors is a clear error', () => {
    const { ultra } = makeWorld();
    assert.throws(() => ultra.move(100, 100), /setMotors/);
});

test('single motor helpers write PWM and direction pins', () => {
    const { ultra, world } = makeWorld();
    ultra.motorSpeed(8, 128);
    assert.strictEqual(lastFor(world.pwm, 8), 513);
    ultra.motorDirection(9, 'backward');
    assert.strictEqual(lastFor(world.digital, 9), 0);
});

// ---------------------------------------------------------------------
// radio delivery + housekeeping
// ---------------------------------------------------------------------

test('delivered radio packets reach handlers', () => {
    const { ultra, radio } = makeWorld();
    const seen = [];
    ultra.start(7);
    assert.strictEqual(radio.group, 7);
    ultra.onMessage((message) => seen.push(message.text));
    radio.deliver(packetFrom(ultra, 3, 'ping'), -45);
    assert.deepStrictEqual(seen, ['ping']);
    assert.strictEqual(ultra.lastSender(), 3);
    assert.strictEqual(ultra.lastText(), 'ping');
});

test('status reports configuration and resetAll clears it', () => {
    const { ultra } = makeWorld();
    ultra.start(5);
    ultra.setId(9);
    ultra.setSenderFilter([1]);
    ultra.setSignalThreshold(-70);
    ultra.defineCommand(101, 'turn left');
    ultra.onMessage(() => {});
    const status = ultra.status();
    assert.strictEqual(status.id, 9);
    assert.strictEqual(status.group, 5);
    assert.deepStrictEqual(status.senderFilter, [1]);
    assert.strictEqual(status.threshold, -70);

    ultra.resetAll();
    assert.deepStrictEqual(ultra.status().senderFilter, []);
    assert.strictEqual(ultra.status().threshold, -128);
});

// ---------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------

let passed = 0;
const failures = [];

for (const [name, fn] of tests) {
    try {
        fn();
        passed++;
    } catch (error) {
        failures.push({ name, error });
    }
}

for (const failure of failures) {
    console.error('FAIL: ' + failure.name);
    console.error(String(failure.error && failure.error.stack || failure.error)
        .split('\n').slice(0, 6).join('\n'));
    console.error('');
}

console.log(passed + ' passed, ' + failures.length + ' failed');
if (failures.length > 0) process.exitCode = 1;
