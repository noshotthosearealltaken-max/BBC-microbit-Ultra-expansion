/**
 * Ultra Expansion Pack - shared runtime for MakeCode.
 *
 * Speaks the same binary packet format as micropython/ultra_expansion.py:
 *
 *   0xE7 | ver<<4 | kind | src | dst | seq | len | payload... | xor checksum
 *
 * so MakeCode boards and MicroPython boards can exchange messages.
 */
namespace ultra {
    export const VERSION = 1;
    export const MAGIC = 0xE7;
    export const HEADER = 6;
    export const MAX_PAYLOAD = 24;

    export const KIND_TEXT = 0;
    export const KIND_CODE = 1;
    export const KIND_CALL = 2;
    export const KIND_RAW = 3;

    export const BROADCAST = 255;

    // Implemented with parallel arrays: MakeCode friendly, no dictionaries.
    export class Message {
        kind: number;
        sender: number;
        destination: number;
        seq: number;
        rssi: number;
        text: string;
        code: number;
        name: string;
        args: string[];
        payload: Buffer;

        constructor() {
            this.kind = 0;
            this.sender = 0;
            this.destination = 0;
            this.seq = 0;
            this.rssi = -100;
            this.text = "";
            this.code = 0;
            this.name = "";
            this.args = [];
            this.payload = null;
        }
    }

    /** Named values kept by the "variables" blocks. */
    export class VariableStore {
        names: string[];
        values: any[];

        constructor() {
            this.names = [];
            this.values = [];
        }

        set(name: string, value: any): void {
            for (let i = 0; i < this.names.length; i++) {
                if (this.names[i] == name) {
                    this.values[i] = value;
                    return;
                }
            }
            this.names.push(name);
            this.values.push(value);
        }

        get(name: string): any {
            for (let i = 0; i < this.names.length; i++) {
                if (this.names[i] == name) return this.values[i];
            }
            return 0;
        }

        has(name: string): boolean {
            for (let i = 0; i < this.names.length; i++) {
                if (this.names[i] == name) return true;
            }
            return false;
        }

        reset(name: string): void {
            let value = this.get(name);
            if (typeof value == "string") this.set(name, "");
            else if (Array.isArray(value)) this.set(name, []);
            else this.set(name, 0);
        }

        clear(): void {
            this.names = [];
            this.values = [];
        }

        count(): number {
            return this.names.length;
        }
    }

    /** Named properties produced by "array to object". */
    export class DataObject {
        names: string[];
        values: any[];

        constructor() {
            this.names = [];
            this.values = [];
        }

        set(name: string, value: any): void {
            for (let i = 0; i < this.names.length; i++) {
                if (this.names[i] == name) {
                    this.values[i] = value;
                    return;
                }
            }
            this.names.push(name);
            this.values.push(value);
        }

        get(name: string): any {
            for (let i = 0; i < this.names.length; i++) {
                if (this.names[i] == name) return this.values[i];
            }
            return 0;
        }

        has(name: string): boolean {
            for (let i = 0; i < this.names.length; i++) {
                if (this.names[i] == name) return true;
            }
            return false;
        }

        keysText(): string {
            let text = "";
            for (let i = 0; i < this.names.length; i++) {
                if (i > 0) text += ", ";
                text += this.names[i];
            }
            return text;
        }

        toArray(): any[] {
            return this.values.slice(0);
        }
    }

    export let variables = new VariableStore();
    export let lastMessageValue: Message = null;
    export let callArgs: string[] = [];
    export let callName = "";

    let selfId = 1;
    let seq = 0;
    let radioGroup = 1;
    let radioReady = false;
    let lastSignal = 0;

    let priorities: number[] = [];
    let commandLabels: string[] = [];

    let anyHandlers: (() => void)[] = [];
    let senderIds: number[] = [];
    let senderHandlers: (() => void)[] = [];
    let signalLevels: number[] = [];
    let signalHandlers: (() => void)[] = [];
    let contentPatterns: string[] = [];
    let contentHandlers: (() => void)[] = [];
    let codeValues: number[] = [];
    let codeHandlers: (() => void)[] = [];
    let callNames: string[] = [];
    let callHandlers: (() => void)[] = [];

    // Motor pins used by the two-motor blocks.
    export let leftSpeedPin: AnalogPin = AnalogPin.P13;
    export let leftDirectionPin: DigitalPin = DigitalPin.P14;
    export let rightSpeedPin: AnalogPin = AnalogPin.P15;
    export let rightDirectionPin: DigitalPin = DigitalPin.P16;

    // ---------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------

    export function checksum(buf: Buffer, length: number): number {
        let value = 0;
        for (let i = 0; i < length; i++) value = value ^ buf[i];
        return value & 0xff;
    }

    export function clampSpeed(value: number): number {
        if (value < 0) return 0;
        if (value > 255) return 255;
        return value;
    }

    export function pwmFromSpeed(speed: number): number {
        return Math.idiv(clampSpeed(speed) * 1023, 255);
    }

    export function setId(id: number): void {
        if (id < 0) id = 0;
        if (id > 255) id = 255;
        selfId = id;
    }

    export function getId(): number {
        return selfId;
    }

    export function setRadioGroup(group: number): void {
        radioGroup = group;
        if (radioReady) radio.setGroup(group);
        else ensureRadio();
    }

    export function signalStrength(): number {
        return radio.receivedSignalStrength();
    }

    export function lastText(): string {
        return lastMessageValue == null ? "" : lastMessageValue.text;
    }

    export function lastSender(): number {
        return lastMessageValue == null ? 0 : lastMessageValue.sender;
    }

    export function lastRssi(): number {
        return lastMessageValue == null ? -100 : lastMessageValue.rssi;
    }

    export function lastCode(): number {
        return lastSignal;
    }

    export function defineCommand(code: number, label: string): void {
        for (let i = 0; i < priorities.length; i++) {
            if (priorities[i] == code) {
                commandLabels[i] = label;
                return;
            }
        }
        priorities.push(code);
        commandLabels.push(label);
    }

    export function decodeCommand(code: number): string {
        for (let i = 0; i < priorities.length; i++) {
            if (priorities[i] == code) return commandLabels[i];
        }
        return "unknown (" + code + ")";
    }

    export function defaultCommands(): void {
        if (priorities.length == 0) {
            defineCommand(101, "turn left");
            defineCommand(102, "turn right");
            defineCommand(103, "stop");
            defineCommand(104, "forward");
        }
        ensureRadio();
    }

    // ---------------------------------------------------------------
    // packets
    // ---------------------------------------------------------------

    export function packBody(kind: number, body: Buffer, to: number): Buffer {
        let size = body == null ? 0 : body.length;
        if (size > MAX_PAYLOAD) size = MAX_PAYLOAD;
        let buf = control.createBuffer(HEADER + size + 1);
        buf[0] = MAGIC;
        buf[1] = (VERSION << 4) | (kind & 0x0f);
        buf[2] = selfId & 0xff;
        buf[3] = to & 0xff;
        buf[4] = seq & 0xff;
        seq = (seq + 1) & 0xff;
        buf[5] = size;
        for (let i = 0; i < size; i++) buf[HEADER + i] = body[i];
        buf[HEADER + size] = checksum(buf, HEADER + size);
        return buf;
    }

    export function packText(kind: number, text: string, to: number): Buffer {
        return packBody(kind, control.createBufferFromUTF8(text), to);
    }

    export function unpack(buf: Buffer): Message {
        if (buf == null || buf.length < HEADER + 1) return null;
        if (buf[0] != MAGIC) return null;
        if ((buf[1] >> 4) != VERSION) return null;
        let length = buf[5];
        if (length > MAX_PAYLOAD || length > buf.length - HEADER - 1) return null;
        if (buf[HEADER + length] != checksum(buf, HEADER + length)) return null;
        let msg = new Message();
        msg.kind = buf[1] & 0x0f;
        msg.sender = buf[2];
        msg.destination = buf[3];
        msg.seq = buf[4];
        msg.payload = buf.slice(HEADER, length);
        msg.text = msg.payload.toString();
        if (msg.kind == KIND_CODE) {
            msg.code = parseInt(msg.text);
            let label = decodeCommand(msg.code);
            if (label.indexOf("unknown") != 0) msg.text = label;
        } else if (msg.kind == KIND_CALL) {
            decodeCallInto(msg);
        }
        return msg;
    }

    export function parseLiteral(text: string): any {
        if (text == "True") return true;
        if (text == "False") return false;
        if (text == "None") return null;
        if (text.length > 0) {
            let numeric = true;
            for (let i = 0; i < text.length; i++) {
                let ch = text.charAt(i);
                if (i == 0 && ch == "-") continue;
                if (ch == "." ) continue;
                if (ch < "0" || ch > "9") {
                    numeric = false;
                    break;
                }
            }
            if (numeric) {
                let dot = text.indexOf(".");
                if (dot >= 0) return parseFloat(text);
                return parseInt(text);
            }
        }
        return text;
    }

    export function decodeCallInto(msg: Message): void {
        let text = msg.payload.toString();
        let parts: string[] = [];
        let current = "";
        for (let i = 0; i < text.length; i++) {
            let ch = text.charAt(i);
            if (ch == "\\" && i + 1 < text.length) {
                current += text.charAt(i + 1);
                i++;
            } else if (ch == "|") {
                parts.push(current);
                current = "";
            } else {
                current += ch;
            }
        }
        parts.push(current);
        msg.name = parts[0];
        msg.args = [];
        for (let i = 1; i < parts.length; i++) msg.args.push(parts[i]);
    }

    export function encodeCall(name: string, args: string[]): string {
        let text = escapePart(name);
        for (let i = 0; i < args.length; i++) text += "|" + escapePart(args[i]);
        return text;
    }

    function escapePart(text: string): string {
        let out = "";
        for (let i = 0; i < text.length; i++) {
            let ch = text.charAt(i);
            if (ch == "\\" || ch == "|") out += "\\";
            out += ch;
        }
        return out;
    }

    export function ensureRadio(): void {
        if (radioReady) return;
        radioReady = true;
        radio.setGroup(radioGroup);
        radio.onReceivedBuffer(function (received: Buffer) {
            handleMessage(received, radio.receivedSignalStrength());
        });
    }

    export function handleMessage(buf: Buffer, rssi: number): void {
        let msg = unpack(buf);
        if (msg == null || (msg.destination != selfId && msg.destination != BROADCAST)) return;
        msg.rssi = rssi;
        lastMessageValue = msg;
        if (msg.kind == KIND_CODE) lastSignal = msg.code;
        if (msg.kind == KIND_CALL) {
            callName = msg.name;
            callArgs = msg.args;
        }
        for (let i = 0; i < anyHandlers.length; i++) anyHandlers[i]();
        for (let i = 0; i < senderHandlers.length; i++) {
            if (senderIds[i] == msg.sender) senderHandlers[i]();
        }
        for (let i = 0; i < signalHandlers.length; i++) {
            if (rssi > signalLevels[i]) signalHandlers[i]();
        }
        for (let i = 0; i < contentHandlers.length; i++) {
            if (msg.text.indexOf(contentPatterns[i]) >= 0) contentHandlers[i]();
        }
        for (let i = 0; i < codeHandlers.length; i++) {
            if (msg.kind == KIND_CODE && codeValues[i] == msg.code) {
                codeHandlers[i]();
            }
        }
        for (let i = 0; i < callHandlers.length; i++) {
            if (msg.kind == KIND_CALL && callNames[i] == msg.name) {
                callHandlers[i]();
            }
        }
    }

    // ---------------------------------------------------------------
    // sending
    // ---------------------------------------------------------------

    export function sendMessage(text: string, to: number): void {
        ensureRadio();
        radio.sendBuffer(packText(KIND_TEXT, text, to));
    }

    export function sendCommand(code: number, to: number): void {
        ensureRadio();
        radio.sendBuffer(packText(KIND_CODE, "" + code, to));
    }

    export function sendCall(name: string, arg1: string, arg2: string, arg3: string): void {
        ensureRadio();
        let args: string[] = [];
        // Keep empty arguments before the last populated argument so indices
        // on the receiving board still match the sender's argument slots.
        if (arg1.length > 0 || arg2.length > 0 || arg3.length > 0) args.push(arg1);
        if (arg2.length > 0 || arg3.length > 0) args.push(arg2);
        if (arg3.length > 0) args.push(arg3);
        radio.sendBuffer(packText(KIND_CALL, encodeCall(name, args), BROADCAST));
    }

    export function callArgument(index: number): string {
        if (index < 0 || index >= callArgs.length) return "";
        return callArgs[index];
    }

    // ---------------------------------------------------------------
    // handlers
    // ---------------------------------------------------------------

    export function onAny(handler: () => void): void {
        ensureRadio();
        anyHandlers.push(handler);
    }

    export function onSender(senderId: number, handler: () => void): void {
        ensureRadio();
        senderIds.push(senderId);
        senderHandlers.push(handler);
    }

    export function onSignalAbove(dbm: number, handler: () => void): void {
        ensureRadio();
        signalLevels.push(dbm);
        signalHandlers.push(handler);
    }

    export function onContent(pattern: string, handler: () => void): void {
        ensureRadio();
        contentPatterns.push(pattern);
        contentHandlers.push(handler);
    }

    export function onCode(code: number, handler: () => void): void {
        ensureRadio();
        codeValues.push(code);
        codeHandlers.push(handler);
    }

    export function onCall(name: string, handler: () => void): void {
        ensureRadio();
        callNames.push(name);
        callHandlers.push(handler);
    }

    // ---------------------------------------------------------------
    // arrays
    // ---------------------------------------------------------------

    export function unpackInto(namesText: string, values: any[]): void {
        let names = splitList(namesText);
        for (let i = 0; i < names.length; i++) {
            let value: any = 0;
            if (i < values.length) value = values[i];
            variables.set(names[i], value);
        }
    }

    export function createVariables(values: any[]): void {
        for (let i = 0; i < values.length; i++) {
            let item = values[i];
            if (Array.isArray(item) && item.length == 2) {
                variables.set("" + item[0], item[1]);
            } else {
                variables.set("" + i, item);
            }
        }
    }

    export function toObject(values: any[], keysText: string): DataObject {
        let object = new DataObject();
        let keys = splitList(keysText);
        for (let i = 0; i < values.length; i++) {
            if (keys.length > 0) {
                if (i < keys.length) object.set(keys[i], values[i]);
            } else {
                let item = values[i];
                if (Array.isArray(item) && item.length == 2) {
                    object.set("" + item[0], item[1]);
                } else {
                    object.set("item" + i, item);
                }
            }
        }
        return object;
    }

    export function splitList(text: string): string[] {
        let parts: string[] = [];
        let current = "";
        for (let i = 0; i < text.length; i++) {
            let ch = text.charAt(i);
            if (ch == "," || ch == ";") {
                if (current.length > 0) parts.push(trim(current));
                current = "";
            } else {
                current += ch;
            }
        }
        if (current.length > 0) parts.push(trim(current));
        return parts;
    }

    function trim(text: string): string {
        let start = 0;
        let end = text.length;
        while (start < end && text.charAt(start) == " ") start++;
        while (end > start && text.charAt(end - 1) == " ") end--;
        let out = "";
        for (let i = start; i < end; i++) out += text.charAt(i);
        return out;
    }

    export function sortArray(values: any[], descending: boolean): any[] {
        let out = values.slice(0);
        for (let i = 1; i < out.length; i++) {
            let item = out[i];
            let j = i - 1;
            while (j >= 0 && compare(out[j], item) > 0) {
                out[j + 1] = out[j];
                j--;
            }
            out[j + 1] = item;
        }
        if (descending) out.reverse();
        return out;
    }

    function compare(first: any, second: any): number {
        if (typeof first == "number" && typeof second == "number") {
            return first - second;
        }
        let a = "" + first;
        let b = "" + second;
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    }

    export function filterArray(values: any[], op: CompareOp, operand: string): any[] {
        let out: any[] = [];
        let number = parseFloat(operand);
        for (let i = 0; i < values.length; i++) {
            let item = values[i];
            let keep = false;
            if (op == CompareOp.Greater) keep = item > number;
            else if (op == CompareOp.Less) keep = item < number;
            else if (op == CompareOp.Equal) keep = ("" + item) == operand;
            else if (op == CompareOp.Contains) keep = ("" + item).indexOf(operand) >= 0;
            if (keep) out.push(item);
        }
        return out;
    }

    export function mapArray(values: any[], op: MathOp, operand: number): any[] {
        let out: any[] = [];
        for (let i = 0; i < values.length; i++) {
            let item = values[i];
            if (op == MathOp.Add) out.push(item + operand);
            else if (op == MathOp.Subtract) out.push(item - operand);
            else if (op == MathOp.Multiply) out.push(item * operand);
            else if (operand != 0) out.push(item / operand);
            else out.push(0);
        }
        return out;
    }

    // ---------------------------------------------------------------
    // motors and servos
    // ---------------------------------------------------------------

    export function setMotorSpeed(pin: AnalogPin, speed: number): void {
        pins.analogWritePin(pin, pwmFromSpeed(speed));
    }

    export function setMotorDirection(pin: DigitalPin, forward: boolean): void {
        pins.digitalWritePin(pin, forward ? 1 : 0);
    }

    export function configureMotors(leftSpeed: AnalogPin, leftDirection: DigitalPin,
        rightSpeed: AnalogPin, rightDirection: DigitalPin): void {
        leftSpeedPin = leftSpeed;
        leftDirectionPin = leftDirection;
        rightSpeedPin = rightSpeed;
        rightDirectionPin = rightDirection;
        pins.analogWritePin(leftSpeedPin, 0);
        pins.analogWritePin(rightSpeedPin, 0);
    }

    export function driveMotor(speedPin: AnalogPin, directionPin: DigitalPin, speed: number): void {
        if (speed < 0) {
            pins.digitalWritePin(directionPin, 0);
            pins.analogWritePin(speedPin, pwmFromSpeed(-speed));
        } else {
            pins.digitalWritePin(directionPin, 1);
            pins.analogWritePin(speedPin, pwmFromSpeed(speed));
        }
    }

    export function move(leftSpeed: number, rightSpeed: number): void {
        driveMotor(leftSpeedPin, leftDirectionPin, leftSpeed);
        driveMotor(rightSpeedPin, rightDirectionPin, rightSpeed);
    }

    export function stopMotors(): void {
        move(0, 0);
    }

    export function setServo(pin: AnalogPin, angle: number): void {
        if (angle < 0) angle = 0;
        if (angle > 180) angle = 180;
        pins.servoWritePin(pin, angle);
    }
}
