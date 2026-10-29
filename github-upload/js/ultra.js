/**
 * Ultra Expansion Pack - JavaScript runtime for the BBC micro:bit.
 *
 * Twenty features, plain JavaScript (no TypeScript syntax). Paste this file
 * into a MakeCode project's JavaScript tab, or into any ES5+ JavaScript
 * environment with the micro:bit APIs available.
 *
 *     ultra.start(1);
 *     ultra.setId(2);
 *     ultra.onCommand(101, function () { ultra.turnLeft(200); });
 *
 * Radio frames are byte-compatible with micropython/ultra_expansion.py and
 * with the MakeCode block extension in this repository:
 *
 *    0xE7 | ver<<4 | kind | src | dst | seq | len | payload... | xor checksum
 */
var ultra = (function () {
    'use strict';

    var VERSION = 1;
    var MAGIC = 0xE7;
    var HEADER = 6;
    var MAX_PAYLOAD = 24;
    var BROADCAST = 255;

    var KIND_TEXT = 0;
    var KIND_CODE = 1;
    var KIND_CALL = 2;
    var KIND_RAW = 3;

    // -----------------------------------------------------------------
    // state
    // -----------------------------------------------------------------

    var selfId = 1;
    var seq = 0;
    var radioGroup = 1;
    var radioReady = false;

    var senderFilter = null;          // null = accept everybody
    var signalThreshold = -128;
    var contentFilter = "";

    var lastMessage = null;
    var lastSignalCode = 0;
    var lastCallName = "";
    var lastCallArgs = [];
    var lastError = null;

    var anyHandlers = [];
    var senderIds = [];
    var senderHandlers = [];
    var signalLevels = [];
    var signalHandlers = [];
    var contentPatterns = [];
    var contentHandlers = [];
    var codeValues = [];
    var codeHandlers = [];

    var commands = {};
    var functions = {};
    var melodies = {};
    var melodyList = [];

    var leftMotor = null;
    var rightMotor = null;

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    function checksum(buffer, length) {
        var value = 0;
        for (var i = 0; i < length; i++) value = value ^ buffer[i];
        return value & 0xff;
    }

    function clampSpeed(speed) {
        if (speed < 0) return 0;
        if (speed > 255) return 255;
        return Math.floor(speed);
    }

    function pwmFromSpeed(speed) {
        return Math.floor(clampSpeed(speed) * 1023 / 255);
    }

    function toBytes(value) {
        if (value === null || value === undefined) return control.createBuffer(0);
        if (typeof value === "string") return control.createBufferFromUTF8(value);
        if (value.length !== undefined) return value;
        return control.createBufferFromUTF8("" + value);
    }

    function textOf(buffer) {
        if (buffer === null || buffer === undefined) return "";
        return buffer.toString();
    }

    function escapePart(text) {
        var out = "";
        for (var i = 0; i < text.length; i++) {
            var ch = text.charAt(i);
            if (ch === "\\" || ch === "|") out += "\\";
            out += ch;
        }
        return out;
    }

    function splitEscaped(text) {
        var parts = [];
        var current = "";
        for (var i = 0; i < text.length; i++) {
            var ch = text.charAt(i);
            if (ch === "\\" && i + 1 < text.length) {
                current += text.charAt(i + 1);
                i++;
            } else if (ch === "|") {
                parts.push(current);
                current = "";
            } else {
                current += ch;
            }
        }
        parts.push(current);
        return parts;
    }

    function parseLiteral(text) {
        if (text === "True") return true;
        if (text === "False") return false;
        if (text === "None") return null;
        if (text.length > 0) {
            var numeric = true;
            for (var i = 0; i < text.length; i++) {
                var ch = text.charAt(i);
                if (i === 0 && ch === "-") continue;
                if (ch === ".") continue;
                if (ch < "0" || ch > "9") {
                    numeric = false;
                    break;
                }
            }
            if (numeric) {
                return text.indexOf(".") >= 0 ? parseFloat(text) : parseInt(text, 10);
            }
        }
        return text;
    }

    function splitNames(names) {
        if (names === null || names === undefined) return [];
        if (names.length !== undefined && typeof names !== "string") {
            return Array.prototype.slice.call(names);
        }
        var parts = [];
        var current = "";
        var text = "" + names;
        for (var i = 0; i < text.length; i++) {
            var ch = text.charAt(i);
            if (ch === "," || ch === ";") {
                if (current.length > 0) parts.push(trim(current));
                current = "";
            } else {
                current += ch;
            }
        }
        if (current.length > 0) parts.push(trim(current));
        return parts;
    }

    function trim(text) {
        var start = 0;
        var end = text.length;
        while (start < end && text.charAt(start) === " ") start++;
        while (end > start && text.charAt(end - 1) === " ") end--;
        var out = "";
        for (var i = start; i < end; i++) out += text.charAt(i);
        return out;
    }

    // -----------------------------------------------------------------
    // packets
    // -----------------------------------------------------------------

    function packBody(kind, body, to) {
        var size = body ? body.length : 0;
        if (size > MAX_PAYLOAD) size = MAX_PAYLOAD;
        var buffer = control.createBuffer(HEADER + size + 1);
        buffer[0] = MAGIC;
        buffer[1] = (VERSION << 4) | (kind & 0x0f);
        buffer[2] = selfId & 0xff;
        buffer[3] = (to === null || to === undefined) ? BROADCAST : (to & 0xff);
        buffer[4] = seq & 0xff;
        seq = (seq + 1) & 0xff;
        buffer[5] = size;
        for (var i = 0; i < size; i++) buffer[HEADER + i] = body[i];
        buffer[HEADER + size] = checksum(buffer, HEADER + size);
        return buffer;
    }

    function packText(kind, text, to) {
        return packBody(kind, control.createBufferFromUTF8(text), to);
    }

    function parse(buffer) {
        if (!buffer || buffer.length < HEADER + 1) return null;
        if (buffer[0] !== MAGIC) return null;
        if ((buffer[1] >> 4) !== VERSION) return null;
        var length = buffer[5];
        if (length > buffer.length - HEADER - 1) return null;
        if (buffer[HEADER + length] !== checksum(buffer, HEADER + length)) return null;

        var payload = buffer.slice(HEADER, HEADER + length);
        var message = {
            kind: buffer[1] & 0x0f,
            sender: buffer[2],
            destination: buffer[3],
            seq: buffer[4],
            rssi: -100,
            payload: payload,
            text: textOf(payload),
            code: 0,
            name: "",
            args: []
        };

        if (message.kind === KIND_CODE) {
            message.code = parseInt(message.text, 10);
            var label = decodeCommand(message.code);
            if (label.indexOf("unknown") !== 0) message.text = label;
        } else if (message.kind === KIND_CALL) {
            var call = decodeCall(message.text);
            message.name = call.name;
            message.args = call.args;
            message.text = call.name;
        }
        return message;
    }

    // -----------------------------------------------------------------
    // radio setup
    // -----------------------------------------------------------------

    function ensureRadio() {
        if (radioReady) return;
        radioReady = true;
        radio.setGroup(radioGroup);
        radio.onReceivedBuffer(function (received) {
            handle(received, radio.receivedSignalStrength());
        });
    }

    function start(group) {
        if (group !== undefined && group !== null) radioGroup = group;
        ensureRadio();
        return true;
    }

    function stop() {
        radioReady = false;
        radio.setGroup(radioGroup);
    }

    function setId(id) {
        id = Math.floor(id);
        if (id < 0) id = 0;
        if (id > 255) id = 255;
        selfId = id;
    }

    function getId() {
        return selfId;
    }

    function setRadioGroup(group) {
        radioGroup = Math.floor(group) & 0xff;
        radio.setGroup(radioGroup);
    }

    function signalStrength() {
        return radio.receivedSignalStrength();
    }

    // -----------------------------------------------------------------
    // filters (features 2-5)
    // -----------------------------------------------------------------

    function setSenderFilter(ids) {
        if (ids === null || ids === undefined) {
            senderFilter = null;
        } else if (ids.length !== undefined && typeof ids !== "string") {
            senderFilter = Array.prototype.slice.call(ids);
        } else {
            senderFilter = [ids];
        }
        return senderFilter;
    }

    function clearSenderFilter() {
        senderFilter = null;
    }

    function setSignalThreshold(dbm) {
        signalThreshold = Math.floor(dbm);
        return signalThreshold;
    }

    function setContentFilter(pattern) {
        contentFilter = "" + pattern;
        return contentFilter;
    }

    function clearFilters() {
        senderFilter = null;
        signalThreshold = -128;
        contentFilter = "";
    }

    // -----------------------------------------------------------------
    // commands and calls (features 6-8)
    // -----------------------------------------------------------------

    function defineCommand(code, label) {
        commands[Math.floor(code)] = "" + label;
    }

    function decodeCommand(code) {
        var value = Math.floor(code);
        if (commands[value] !== undefined) return commands[value];
        return "unknown (" + value + ")";
    }

    function lastSignal() {
        return lastSignalCode;
    }

    function lastText() {
        return lastMessage === null ? "" : lastMessage.text;
    }

    function lastRssi() {
        return lastMessage === null ? -100 : lastMessage.rssi;
    }

    function lastSender() {
        return lastMessage === null ? 0 : lastMessage.sender;
    }

    function lastCallArguments() {
        return lastCallArgs.slice(0);
    }

    function encodeCall(name, args) {
        var text = escapePart("" + name);
        var list = args || [];
        for (var i = 0; i < list.length; i++) text += "|" + escapePart("" + list[i]);
        return text;
    }

    function decodeCall(payload) {
        var parts = splitEscaped("" + payload);
        var args = [];
        for (var i = 1; i < parts.length; i++) args.push(parseLiteral(parts[i]));
        return { name: parts[0], args: args };
    }

    // -----------------------------------------------------------------
    // sending
    // -----------------------------------------------------------------

    function sendMessage(text, to) {
        ensureRadio();
        radio.sendBuffer(packText(KIND_TEXT, "" + text, to));
    }

    function sendCommand(code, to) {
        ensureRadio();
        radio.sendBuffer(packText(KIND_CODE, "" + Math.floor(code), to));
    }

    function sendCall(name, args, to) {
        ensureRadio();
        radio.sendBuffer(packText(KIND_CALL, encodeCall(name, args), to));
    }

    function sendRaw(data, to) {
        ensureRadio();
        radio.sendBuffer(packBody(KIND_RAW, toBytes(data), to));
    }

    function registerFunction(name, handler) {
        functions["" + name] = handler;
    }

    // -----------------------------------------------------------------
    // handlers
    // -----------------------------------------------------------------

    function onMessage(handler) {
        ensureRadio();
        anyHandlers.push(handler);
        return handler;
    }

    function onSender(senderId, handler) {
        ensureRadio();
        senderIds.push(Math.floor(senderId));
        senderHandlers.push(handler);
        return handler;
    }

    function onSignalAbove(dbm, handler) {
        ensureRadio();
        signalLevels.push(Math.floor(dbm));
        signalHandlers.push(handler);
        return handler;
    }

    function onContent(pattern, handler) {
        ensureRadio();
        contentPatterns.push("" + pattern);
        contentHandlers.push(handler);
        return handler;
    }

    function onCommand(code, handler) {
        ensureRadio();
        codeValues.push(Math.floor(code));
        codeHandlers.push(handler);
        return handler;
    }

    function offHandlers() {
        anyHandlers = [];
        senderIds = [];
        senderHandlers = [];
        signalLevels = [];
        signalHandlers = [];
        contentPatterns = [];
        contentHandlers = [];
        codeValues = [];
        codeHandlers = [];
    }

    function handle(raw, rssi) {
        var message = parse(raw);
        if (message === null) return null;
        message.rssi = (rssi === undefined || rssi === null) ? -100 : rssi;
        lastMessage = message;

        if (senderFilter !== null && senderFilter.indexOf(message.sender) < 0) return null;
        if (message.rssi < signalThreshold) return null;
        if (contentFilter !== "" && message.text.indexOf(contentFilter) < 0) return null;

        if (message.kind === KIND_CODE) {
            lastSignalCode = message.code;
        } else if (message.kind === KIND_CALL) {
            lastCallName = message.name;
            lastCallArgs = message.args;
            if (functions[message.name] !== undefined) {
                try {
                    functions[message.name].apply(null, message.args);
                } catch (error) {
                    lastError = error;
                }
            }
        }

        for (var i = 0; i < anyHandlers.length; i++) {
            try { anyHandlers[i](message); } catch (error1) { lastError = error1; }
        }
        for (var s = 0; s < senderHandlers.length; s++) {
            if (senderIds[s] === message.sender) {
                try { senderHandlers[s](message); } catch (error2) { lastError = error2; }
            }
        }
        for (var g = 0; g < signalHandlers.length; g++) {
            if (message.rssi >= signalLevels[g]) {
                try { signalHandlers[g](message); } catch (error3) { lastError = error3; }
            }
        }
        for (var c = 0; c < contentHandlers.length; c++) {
            if (message.text.indexOf(contentPatterns[c]) >= 0) {
                try { contentHandlers[c](message); } catch (error4) { lastError = error4; }
            }
        }
        for (var k = 0; k < codeHandlers.length; k++) {
            if (message.kind === KIND_CODE && codeValues[k] === message.code) {
                try { codeHandlers[k](message); } catch (error5) { lastError = error5; }
            }
        }
        return message;
    }

    // -----------------------------------------------------------------
    // variables (features 9-14)
    // -----------------------------------------------------------------

    function Store() {
        this.names = [];
        this.values = [];
    }

    Store.prototype.set = function (name, value) {
        name = "" + name;
        for (var i = 0; i < this.names.length; i++) {
            if (this.names[i] === name) {
                this.values[i] = value;
                return value;
            }
        }
        this.names.push(name);
        this.values.push(value);
        return value;
    };

    Store.prototype.get = function (name, fallback) {
        name = "" + name;
        for (var i = 0; i < this.names.length; i++) {
            if (this.names[i] === name) return this.values[i];
        }
        return fallback === undefined ? 0 : fallback;
    };

    Store.prototype.has = function (name) {
        name = "" + name;
        for (var i = 0; i < this.names.length; i++) {
            if (this.names[i] === name) return true;
        }
        return false;
    };

    Store.prototype.remove = function (name) {
        name = "" + name;
        for (var i = 0; i < this.names.length; i++) {
            if (this.names[i] === name) {
                this.names.splice(i, 1);
                this.values.splice(i, 1);
                return true;
            }
        }
        return false;
    };

    Store.prototype.keys = function () {
        return this.names.slice(0);
    };

    Store.prototype.clear = function (keep) {
        if (!keep || keep.length === 0) {
            this.names = [];
            this.values = [];
            return;
        }
        for (var i = this.names.length - 1; i >= 0; i--) {
            if (keep.indexOf(this.names[i]) < 0) {
                this.names.splice(i, 1);
                this.values.splice(i, 1);
            }
        }
    };

    Store.prototype.snapshot = function () {
        var out = {};
        for (var i = 0; i < this.names.length; i++) out[this.names[i]] = this.values[i];
        return out;
    };

    var variables = new Store();

    function unpack(array, count, pad) {
        var out = [];
        if (count === undefined || count === null) return Array.prototype.slice.call(array);
        var filler = pad === undefined ? null : pad;
        for (var i = 0; i < count; i++) {
            out.push(i < array.length ? array[i] : filler);
        }
        return out;
    }

    function setVariables(names, array) {
        var nameList = splitNames(names);
        var values = unpack(array, nameList.length, null);
        for (var i = 0; i < nameList.length; i++) {
            variables.set(nameList[i], values[i]);
        }
        return values;
    }

    function variablesFromKeys(input) {
        if (input === null || input === undefined) return {};
        if (input.length !== undefined && typeof input !== "string") {
            for (var i = 0; i < input.length; i++) {
                var item = input[i];
                if (item && item.length === 2) {
                    variables.set(item[0], item[1]);
                } else {
                    variables.set(i, item);
                }
            }
        } else {
            for (var key in input) {
                if (Object.prototype.hasOwnProperty.call(input, key)) {
                    variables.set(key, input[key]);
                }
            }
        }
        return variables.snapshot();
    }

    function arrayToObject(array, keys) {
        var object = {};
        var nameList = splitNames(keys);
        for (var i = 0; i < array.length; i++) {
            var item = array[i];
            if (nameList.length > 0) {
                if (i < nameList.length) object[nameList[i]] = item;
            } else if (item && item.length === 2) {
                object[item[0]] = item[1];
            } else {
                object["item" + i] = item;
            }
        }
        return object;
    }

    function defaultFor(value) {
        if (typeof value === "string") return "";
        if (Array.isArray(value)) return [];
        if (value === true || value === false) return false;
        return 0;
    }

    function resetVariable(name, value) {
        var current = variables.get(name, 0);
        variables.set(name, value === undefined ? defaultFor(current) : value);
        return variables.get(name);
    }

    function resetArray(array) {
        if (array && array.length !== undefined) array.length = 0;
        return array;
    }

    function clearVariables(keep) {
        var keepList = keep === undefined || keep === null ? [] : splitNames(keep);
        variables.clear(keepList);
        return variables.keys();
    }

    // -----------------------------------------------------------------
    // sorting, filtering, mapping (features 15-17)
    // -----------------------------------------------------------------

    function compareValues(first, second) {
        if (typeof first === "number" && typeof second === "number") {
            return first - second;
        }
        var a = "" + first;
        var b = "" + second;
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    }

    function sortArray(array, descending) {
        var out = Array.prototype.slice.call(array);
        for (var i = 1; i < out.length; i++) {
            var item = out[i];
            var j = i - 1;
            while (j >= 0 && compareValues(out[j], item) > 0) {
                out[j + 1] = out[j];
                j--;
            }
            out[j + 1] = item;
        }
        if (descending) out.reverse();
        return out;
    }

    function sortArrayInPlace(array, descending) {
        var ordered = sortArray(array, descending);
        for (var i = 0; i < ordered.length; i++) array[i] = ordered[i];
        array.length = ordered.length;
        return array;
    }

    function filterArray(array, predicate) {
        var out = [];
        for (var i = 0; i < array.length; i++) {
            if (predicate(array[i])) out.push(array[i]);
        }
        return out;
    }

    function mapArray(array, transform) {
        var out = [];
        for (var i = 0; i < array.length; i++) out.push(transform(array[i]));
        return out;
    }

    function greaterThan(value) {
        return function (item) { return item > value; };
    }

    function lessThan(value) {
        return function (item) { return item < value; };
    }

    function equalTo(value) {
        return function (item) { return item === value; };
    }

    function between(low, high) {
        return function (item) { return item >= low && item <= high; };
    }

    function containsText(text) {
        return function (item) { return ("" + item).indexOf(text) >= 0; };
    }

    function startsWith(text) {
        return function (item) { return ("" + item).indexOf(text) === 0; };
    }

    function isEven(item) {
        return item % 2 === 0;
    }

    function isOdd(item) {
        return Math.abs(item % 2) === 1;
    }

    function positive(item) {
        return item > 0;
    }

    function negative(item) {
        return item < 0;
    }

    function multiplyBy(factor) {
        return function (item) { return item * factor; };
    }

    function add(amount) {
        return function (item) { return item + amount; };
    }

    function subtract(amount) {
        return function (item) { return item - amount; };
    }

    function divideBy(factor) {
        return function (item) { return factor === 0 ? 0 : item / factor; };
    }

    function mapRange(fromLow, fromHigh, toLow, toHigh) {
        var span = fromHigh - fromLow;
        if (span === 0) span = 1;
        return function (item) {
            return toLow + (item - fromLow) * (toHigh - toLow) / span;
        };
    }

    // -----------------------------------------------------------------
    // motors and servos (features 18-20)
    // -----------------------------------------------------------------

    function Motor(speedPin, directionPin, invert) {
        this.speedPin = speedPin;
        this.directionPin = (directionPin === undefined) ? null : directionPin;
        this.invert = !!invert;
        this._speed = 0;
        this._forward = true;
        pins.analogWritePin(this.speedPin, 0);
        if (this.directionPin !== null) pins.digitalWritePin(this.directionPin, 0);
    }

    Motor.prototype.setSpeed = function (speed) {
        this._speed = clampSpeed(speed);
        pins.analogWritePin(this.speedPin, pwmFromSpeed(this._speed));
        return this._speed;
    };

    Motor.prototype.setDirection = function (direction) {
        var forward = direction;
        if (typeof direction === "string") forward = direction.toLowerCase() !== "backward";
        this._forward = !!forward;
        if (this.directionPin !== null) {
            var level = this._forward ? 1 : 0;
            if (this.invert) level = 1 - level;
            pins.digitalWritePin(this.directionPin, level);
        }
        return this._forward;
    };

    Motor.prototype.drive = function (value) {
        value = Math.floor(value);
        if (value < 0) {
            this.setDirection(false);
            return this.setSpeed(-value);
        }
        this.setDirection(true);
        return this.setSpeed(value);
    };

    Motor.prototype.forward = function (speed) {
        this.setDirection(true);
        return this.setSpeed(speed === undefined ? 255 : speed);
    };

    Motor.prototype.backward = function (speed) {
        this.setDirection(false);
        return this.setSpeed(speed === undefined ? 255 : speed);
    };

    Motor.prototype.stop = function () {
        this._speed = 0;
        pins.analogWritePin(this.speedPin, 0);
        return 0;
    };

    Motor.prototype.brake = function () {
        this.stop();
        if (this.directionPin !== null) pins.digitalWritePin(this.directionPin, 1);
        return 0;
    };

    Motor.prototype.speed = function () {
        return this._speed;
    };

    Motor.prototype.direction = function () {
        return this._forward;
    };

    function Servo(pin, travel, stepDelay) {
        this.pin = pin;
        this.travel = travel === undefined ? 180 : travel;
        this.stepDelay = stepDelay === undefined ? 15 : stepDelay;
        this._angle = 0;
        pins.servoWritePin(this.pin, 0);
    }

    Servo.prototype.setAngle = function (angle, smooth) {
        angle = Math.floor(angle);
        if (angle < 0) angle = 0;
        if (angle > this.travel) angle = this.travel;
        var animated = smooth === undefined ? true : !!smooth;
        if (animated && this.stepDelay > 0) {
            var step = angle > this._angle ? 4 : -4;
            while (this._angle !== angle) {
                this._angle += step;
                if ((step > 0 && this._angle > angle) ||
                    (step < 0 && this._angle < angle)) {
                    this._angle = angle;
                }
                pins.servoWritePin(this.pin, this._angle);
                basic.pause(this.stepDelay);
            }
        } else {
            this._angle = angle;
            pins.servoWritePin(this.pin, angle);
        }
        return this._angle;
    };

    Servo.prototype.angle = function () {
        return this._angle;
    };

    Servo.prototype.center = function () {
        return this.setAngle(Math.floor(this.travel / 2));
    };

    function setMotors(left, right) {
        leftMotor = left;
        rightMotor = right;
        return true;
    }

    function configureMotorPins(leftSpeedPin, leftDirectionPin,
        rightSpeedPin, rightDirectionPin) {
        leftMotor = new Motor(leftSpeedPin, leftDirectionPin);
        rightMotor = new Motor(rightSpeedPin, rightDirectionPin);
    }

    function move(leftSpeed, rightSpeed) {
        if (leftMotor === null || rightMotor === null) {
            throw new Error("call ultra.setMotors() or configureMotorPins() first");
        }
        leftSpeed = Math.floor(leftSpeed);
        rightSpeed = Math.floor(rightSpeed);
        leftMotor.drive(leftSpeed);
        rightMotor.drive(rightSpeed);
        return [leftSpeed, rightSpeed];
    }

    function forward(speed) {
        var value = speed === undefined ? 255 : speed;
        return move(value, value);
    }

    function backward(speed) {
        var value = speed === undefined ? 255 : speed;
        return move(-value, -value);
    }

    function turnLeft(speed) {
        var value = speed === undefined ? 180 : speed;
        return move(-value, value);
    }

    function turnRight(speed) {
        var value = speed === undefined ? 180 : speed;
        return move(value, -value);
    }

    function stopMotors() {
        if (leftMotor !== null) leftMotor.stop();
        if (rightMotor !== null) rightMotor.stop();
    }

    function motorSpeed(pin, speed) {
        pins.analogWritePin(pin, pwmFromSpeed(speed));
    }

    function motorDirection(pin, direction) {
        var forwardFlag = typeof direction === "string"
            ? direction.toLowerCase() !== "backward"
            : !!direction;
        pins.digitalWritePin(pin, forwardFlag ? 1 : 0);
    }

    function setServo(pin, angle) {
        angle = Math.floor(angle);
        if (angle < 0) angle = 0;
        if (angle > 180) angle = 180;
        pins.servoWritePin(pin, angle);
    }

    // -----------------------------------------------------------------
    // melodies (feature 1)
    // -----------------------------------------------------------------

    var MB8_RATES = [7812, 8000, 11025, 16000, 22050, 4000];

    function isMb8(data) {
        return !!data && data.length > 5 && data[0] === 0x4d &&
            data[1] === 0x42 && data[2] === 0x38;
    }

    function mb8Rate(data) {
        if (!isMb8(data)) return 7812;
        var code = data[4] & 0x0f;
        return code < MB8_RATES.length ? MB8_RATES[code] : 7812;
    }

    function decodeMb8(data) {
        if (!isMb8(data)) throw new Error("not MB8 melody data");
        var level = 128;
        var samples = [];
        for (var i = 5; i < data.length; i++) {
            var byte = data[i];
            level += (byte & 0x0f) - 8;
            if (level < 0) level = 0;
            else if (level > 255) level = 255;
            samples.push(level);

            level += ((byte >> 4) & 0x0f) - 8;
            if (level < 0) level = 0;
            else if (level > 255) level = 255;
            samples.push(level);
        }
        return samples;
    }

    /**
     * Register a melody by name.
     *
     * Notes use the MakeCode melody syntax ("c5 e5 g5 c6"), which plays at
     * full quality. Pass MB8 bytes as the third argument instead (or call
     * registerMelodyData) for converted audio, which is played through
     * pins.analogPitch because JavaScript cannot stream PCM to the DAC.
     */
    function registerMelody(name, notes, tempo) {
        melodies[name] = {
            notes: "" + notes,
            tempo: tempo === undefined ? 120 : tempo,
            data: null
        };
        if (melodyList.indexOf(name) < 0) melodyList.push(name);
        return name;
    }

    function registerMelodyData(name, data, tempo) {
        if (!isMb8(data)) throw new Error("melody data must start with MB8");
        melodies[name] = {
            notes: null,
            tempo: tempo === undefined ? 120 : tempo,
            data: data
        };
        if (melodyList.indexOf(name) < 0) melodyList.push(name);
        return name;
    }

    function playMelody(name) {
        var melody = melodies[name];
        if (melody === undefined) throw new Error("unknown melody: " + name);
        if (melody.notes !== null) {
            music.playMelody(melody.notes, melody.tempo);
        } else {
            playMb8(melody.data);
        }
    }

    function playMb8(data) {
        var samples = decodeMb8(data);
        var rate = mb8Rate(data);
        var block = Math.floor(rate / 25);
        if (block < 1) block = 1;
        var index = 0;
        while (index < samples.length) {
            var end = Math.min(index + block, samples.length);
            var energy = 0;
            var count = 0;
            while (index < end) {
                var value = samples[index] - 128;
                if (value < 0) value = -value;
                energy += value;
                count++;
                index++;
            }
            var amplitude = count > 0 ? Math.floor(energy / count) : 0;
            if (amplitude > 4) {
                pins.analogPitch(180 + amplitude * 8, 40);
            } else {
                basic.pause(40);
            }
        }
    }

    function stopMelody() {
        music.stopAllSounds();
    }

    function melodyNames() {
        return melodyList.slice(0);
    }

    function melodyDuration(name) {
        var melody = melodies[name];
        if (melody === undefined || melody.data === null) return 0;
        var samples = (melody.data.length - 5) * 2;
        return Math.floor(samples * 1000 / mb8Rate(melody.data));
    }

    // -----------------------------------------------------------------
    // housekeeping
    // -----------------------------------------------------------------

    function status() {
        return {
            id: selfId,
            group: radioGroup,
            rssi: lastMessage === null ? -100 : lastMessage.rssi,
            senderFilter: senderFilter === null ? [] : senderFilter.slice(0),
            threshold: signalThreshold,
            contentFilter: contentFilter,
            variables: variables.keys(),
            melodies: melodyList.slice(0),
            version: VERSION
        };
    }

    function resetAll() {
        clearFilters();
        offHandlers();
        functions = {};
        variables.clear();
        leftMotor = null;
        rightMotor = null;
        lastMessage = null;
        lastSignalCode = 0;
        lastCallName = "";
        lastCallArgs = [];
        lastError = null;
    }

    function lastErrorValue() {
        return lastError;
    }

    // -----------------------------------------------------------------
    // public API
    // -----------------------------------------------------------------

    return {
        VERSION: VERSION,
        MAGIC: MAGIC,
        BROADCAST: BROADCAST,
        KIND_TEXT: KIND_TEXT,
        KIND_CODE: KIND_CODE,
        KIND_CALL: KIND_CALL,
        KIND_RAW: KIND_RAW,

        start: start,
        stop: stop,
        setId: setId,
        getId: getId,
        setRadioGroup: setRadioGroup,
        signalStrength: signalStrength,

        setSenderFilter: setSenderFilter,
        clearSenderFilter: clearSenderFilter,
        setSignalThreshold: setSignalThreshold,
        setContentFilter: setContentFilter,
        clearFilters: clearFilters,

        defineCommand: defineCommand,
        decodeCommand: decodeCommand,
        lastSignal: lastSignal,
        lastText: lastText,
        lastRssi: lastRssi,
        lastSender: lastSender,
        lastCallArguments: lastCallArguments,
        lastError: lastErrorValue,

        onMessage: onMessage,
        onSender: onSender,
        onSignalAbove: onSignalAbove,
        onContent: onContent,
        onCommand: onCommand,
        offHandlers: offHandlers,

        sendMessage: sendMessage,
        sendCommand: sendCommand,
        sendCall: sendCall,
        sendRaw: sendRaw,
        registerFunction: registerFunction,
        encodeCall: encodeCall,
        decodeCall: decodeCall,

        packText: packText,
        packBody: packBody,
        parse: parse,
        handle: handle,

        variables: variables,
        unpack: unpack,
        setVariables: setVariables,
        variablesFromKeys: variablesFromKeys,
        arrayToObject: arrayToObject,
        resetVariable: resetVariable,
        resetArray: resetArray,
        clearVariables: clearVariables,

        sortArray: sortArray,
        sortArrayInPlace: sortArrayInPlace,
        filterArray: filterArray,
        mapArray: mapArray,
        greaterThan: greaterThan,
        lessThan: lessThan,
        equalTo: equalTo,
        between: between,
        containsText: containsText,
        startsWith: startsWith,
        isEven: isEven,
        isOdd: isOdd,
        positive: positive,
        negative: negative,
        add: add,
        subtract: subtract,
        multiplyBy: multiplyBy,
        divideBy: divideBy,
        mapRange: mapRange,

        Motor: Motor,
        Servo: Servo,
        setMotors: setMotors,
        configureMotorPins: configureMotorPins,
        move: move,
        forward: forward,
        backward: backward,
        turnLeft: turnLeft,
        turnRight: turnRight,
        stopMotors: stopMotors,
        motorSpeed: motorSpeed,
        motorDirection: motorDirection,
        setServo: setServo,

        registerMelody: registerMelody,
        registerMelodyData: registerMelodyData,
        playMelody: playMelody,
        stopMelody: stopMelody,
        melodyNames: melodyNames,
        melodyDuration: melodyDuration,
        decodeMb8: decodeMb8,
        isMb8: isMb8,

        status: status,
        resetAll: resetAll
    };
})();
