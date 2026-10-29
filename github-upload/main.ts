/**
 * Ultra Expansion Pack - MakeCode blocks.
 *
 * Twenty features, grouped in the toolbox. The binary radio protocol is shared
 * with micropython/ultra_expansion.py, so both editors can talk to each other.
 */
enum MotorDirection {
    //% block="forward"
    Forward = 1,
    //% block="backward"
    Backward = 0
}

enum SortOrder {
    //% block="ascending"
    Ascending = 0,
    //% block="descending"
    Descending = 1
}

enum CompareOp {
    //% block=">"
    Greater = 0,
    //% block="<"
    Less = 1,
    //% block="="
    Equal = 2,
    //% block="contains"
    Contains = 3
}

enum MathOp {
    //% block="add"
    Add = 0,
    //% block="subtract"
    Subtract = 1,
    //% block="multiply"
    Multiply = 2,
    //% block="divide"
    Divide = 3
}

//% color="#00B894" weight=100 icon="\uf0c1" block="Ultra"
namespace ultra {
    // -----------------------------------------------------------------
    // 1. melodies
    // -----------------------------------------------------------------

    let melodyNames: string[] = [];
    let melodyNotes: string[] = [];
    let melodyTempo = 120;

    /**
     * Teach the project a melody so it can be played by name.
     * Notes use the MakeCode melody syntax, e.g. "c5 e5 g5 c6".
     */
    //% block="register melody %name with notes %notes"
    //% blockId=ultra_register_melody
    //% name.defl="startup" notes.defl="c5 e5 g5 c6"
    //% group="1. Melodies" weight=90
    export function registerMelody(name: string, notes: string): void {
        for (let i = 0; i < melodyNames.length; i++) {
            if (melodyNames[i] == name) {
                melodyNotes[i] = notes;
                return;
            }
        }
        melodyNames.push(name);
        melodyNotes.push(notes);
    }

    /**
     * Play a melody that was registered by name.
     */
    //% block="play melody %name"
    //% blockId=ultra_play_melody
    //% name.defl="startup"
    //% group="1. Melodies" weight=80
    export function playMelody(name: string): void {
        for (let i = 0; i < melodyNames.length; i++) {
            if (melodyNames[i] == name) {
                music.playMelody(melodyNotes[i], melodyTempo);
                return;
            }
        }
        music.playTone(440, 200);
    }

    /**
     * Set the tempo used when playing melodies.
     */
    //% block="set melody tempo to %tempo"
    //% blockId=ultra_melody_tempo
    //% tempo.min=40 tempo.max=400 tempo.defl=120
    //% group="1. Melodies" weight=70
    export function setMelodyTempo(tempo: number): void {
        melodyTempo = tempo;
    }

    /**
     * Stop any melody that is playing.
     */
    //% block="stop melody"
    //% blockId=ultra_stop_melody
    //% group="1. Melodies" weight=60
    export function stopMelody(): void {
        music.stopAllSounds();
    }

    // -----------------------------------------------------------------
    // 2-8. radio
    // -----------------------------------------------------------------

    /**
     * Set this micro:bit's sender ID, used by the filtering blocks.
     */
    //% block="set my radio ID to %id"
    //% blockId=ultra_set_id
    //% id.min=0 id.max=255 id.defl=1
    //% group="2. Radio" weight=100
    export function setIdBlock(id: number): void {
        setId(id);
        defaultCommands();
    }

    /**
     * Join a radio group and start listening with the Ultra protocol.
     */
    //% block="start ultra radio on group %group"
    //% blockId=ultra_start_radio
    //% group.min=0 group.max=255 group.defl=1
    //% group="2. Radio" weight=95
    export function startRadio(group: number): void {
        setRadioGroup(group);
        defaultCommands();
    }

    /**
     * Runs whenever an Ultra packet arrives.
     */
    //% block="on ultra radio message"
    //% blockId=ultra_on_message
    //% group="2. Radio" weight=90
    export function onMessage(handler: () => void): void {
        onAny(handler);
    }

    /**
     * Runs only for packets from one sender ID.
     */
    //% block="on radio received from sender ID %senderId"
    //% blockId=ultra_on_sender
    //% senderId.min=0 senderId.max=255 senderId.defl=1
    //% group="2. Radio" weight=85
    export function onSenderBlock(senderId: number, handler: () => void): void {
        onSender(senderId, handler);
    }

    /**
     * RSSI of the last packet in dBm: about -100 (weak) to -28 (strong).
     */
    //% block="radio signal strength (dBm)"
    //% blockId=ultra_signal_strength
    //% group="2. Radio" weight=80
    export function signalStrengthBlock(): number {
        return signalStrength();
    }

    /**
     * Runs when a packet arrives with a signal stronger than the threshold.
     */
    //% block="on radio received if signal strength > %dbm dBm"
    //% blockId=ultra_on_signal
    //% dbm.min=-128 dbm.max=0 dbm.defl=-70
    //% group="2. Radio" weight=75
    export function onSignalBlock(dbm: number, handler: () => void): void {
        onSignalAbove(dbm, handler);
    }

    /**
     * Runs when a packet arrives whose text contains the pattern.
     */
    //% block="receive signal containing %pattern"
    //% blockId=ultra_on_content
    //% pattern.defl="LED"
    //% group="2. Radio" weight=70
    export function onContentBlock(pattern: string, handler: () => void): void {
        onContent(pattern, handler);
    }

    /**
     * Send text to one board (0-254) or everybody (255).
     */
    //% block="send message %text to ID %to"
    //% blockId=ultra_send_message
    //% to.min=0 to.max=255 to.defl=255 text.defl="hello"
    //% group="2. Radio" weight=65
    export function sendMessageBlock(text: string, to: number): void {
        sendMessage(text, to);
    }

    /**
     * The text (or command label) of the last accepted packet.
     */
    //% block="last message text"
    //% blockId=ultra_last_text
    //% group="2. Radio" weight=60
    export function lastTextBlock(): string {
        return lastText();
    }

    /**
     * The sender ID of the last accepted packet.
     */
    //% block="last sender ID"
    //% blockId=ultra_last_sender
    //% group="2. Radio" weight=55
    export function lastSenderBlock(): number {
        return lastSender();
    }

    /**
     * Send a numeric command code (101 = turn left, 102 = turn right...).
     */
    //% block="send command code %code to ID %to"
    //% blockId=ultra_send_code
    //% code.defl=101 to.min=0 to.max=255 to.defl=255
    //% group="3. Command codes" weight=100
    export function sendCommandBlock(code: number, to: number): void {
        sendCommand(code, to);
        defaultCommands();
    }

    /**
     * Give a numeric code a readable name.
     */
    //% block="define command %code as %label"
    //% blockId=ultra_define_command
    //% code.defl=105 label.defl="dance"
    //% group="3. Command codes" weight=95
    export function defineCommandBlock(code: number, label: string): void {
        defaultCommands();
        defineCommand(code, label);
    }

    /**
     * Runs when the matching command code arrives.
     */
    //% block="on command code %code"
    //% blockId=ultra_on_code
    //% code.defl=101
    //% group="3. Command codes" weight=90
    export function onCommandBlock(code: number, handler: () => void): void {
        defaultCommands();
        onCode(code, handler);
    }

    /**
     * Turn a received code back into readable text.
     */
    //% block="decode received code %code"
    //% blockId=ultra_decode_code
    //% code.defl=101
    //% group="3. Command codes" weight=85
    export function decodeCommandBlock(code: number): string {
        defaultCommands();
        return decodeCommand(code);
    }

    /**
     * The last command code that arrived.
     */
    //% block="last signal code"
    //% blockId=ultra_last_code
    //% group="3. Command codes" weight=80
    export function lastCodeBlock(): number {
        return lastCode();
    }

    /**
     * Serialise a call: send a function name plus up to three arguments.
     */
    //% block="send serialized function %name arg %arg1 %arg2 %arg3"
    //% blockId=ultra_send_call
    //% name.defl="drive" arg1.defl="0" arg2.defl="" arg3.defl=""
    //% group="3. Command codes" weight=75
    export function sendCallBlock(name: string, arg1: string, arg2: string, arg3: string): void {
        sendCall(name, arg1, arg2, arg3);
    }

    /**
     * Run code when a matching serialised function call arrives.
     */
    //% block="on serialized function %name"
    //% blockId=ultra_on_call
    //% name.defl="drive"
    //% group="3. Command codes" weight=70
    export function onCallBlock(name: string, handler: () => void): void {
        onCall(name, handler);
    }

    /**
     * Read an argument of the received function call (0 is the first).
     */
    //% block="call argument %index"
    //% blockId=ultra_call_argument
    //% index.min=0 index.max=2 index.defl=0
    //% group="3. Command codes" weight=65
    export function callArgumentBlock(index: number): string {
        return callArgument(index);
    }

    // -----------------------------------------------------------------
    // 9-17. variables and arrays
    // -----------------------------------------------------------------

    /**
     * Set several variables at once from an array.
     */
    //% block="set variables %names from array %values"
    //% blockId=ultra_unpack
    //% names.defl="x, y, z"
    //% group="4. Variables" weight=100
    export function unpackBlock(names: string, values: any[]): void {
        unpackInto(names, values);
    }

    /**
     * Create variables from array keys (pairs) or indices.
     */
    //% block="create variables from array keys %values"
    //% blockId=ultra_create_vars
    //% group="4. Variables" weight=95
    export function createVariablesBlock(values: any[]): void {
        createVariables(values);
    }

    /**
     * Read a variable created by the Ultra blocks.
     */
    //% block="variable %name"
    //% blockId=ultra_get_var
    //% name.defl="x"
    //% group="4. Variables" weight=90
    export function getVariableBlock(name: string): any {
        return variables.get(name);
    }

    /**
     * Write a variable in the Ultra variable store.
     */
    //% block="set variable %name to %value"
    //% blockId=ultra_set_var
    //% name.defl="x"
    //% group="4. Variables" weight=85
    export function setVariableBlock(name: string, value: any): void {
        variables.set(name, value);
    }

    /**
     * Turn a flat array into an object with named properties.
     */
    //% block="array %values to object %keys"
    //% blockId=ultra_to_object
    //% keys.defl="x, y, z"
    //% group="4. Variables" weight=80
    export function toObjectBlock(values: any[], keys: string): DataObject {
        return toObject(values, keys);
    }

    /**
     * Read a property of an Ultra object.
     */
    //% block="property %name of object %object"
    //% blockId=ultra_object_property
    //% name.defl="x"
    //% group="4. Variables" weight=75
    export function objectPropertyBlock(object: DataObject, name: string): any {
        return object == null ? 0 : object.get(name);
    }

    /**
     * Reset one variable to 0, "" or an empty array.
     */
    //% block="reset variable %name"
    //% blockId=ultra_reset_var
    //% name.defl="x"
    //% group="4. Variables" weight=70
    export function resetVariableBlock(name: string): void {
        variables.reset(name);
    }

    /**
     * Empty an array and set its length to zero.
     */
    //% block="reset array %values"
    //% blockId=ultra_reset_array
    //% group="4. Variables" weight=65
    export function resetArrayBlock(values: any[]): void {
        while (values.length > 0) values.pop();
    }

    /**
     * Clear every variable in the Ultra variable store.
     */
    //% block="clear all variables"
    //% blockId=ultra_clear_vars
    //% group="4. Variables" weight=60
    export function clearVariablesBlock(): void {
        variables.clear();
    }

    /**
     * Sort an array, returning a new one.
     */
    //% block="sort array %values %order"
    //% blockId=ultra_sort
    //% group="5. Array tools" weight=100
    export function sortBlock(values: any[], order: SortOrder): any[] {
        return sortArray(values, order == SortOrder.Descending);
    }

    /**
     * Keep only the elements that match a condition.
     */
    //% block="filter array %values where value %op %operand"
    //% blockId=ultra_filter
    //% operand.defl="5"
    //% group="5. Array tools" weight=95
    export function filterBlock(values: any[], op: CompareOp, operand: string): any[] {
        return filterArray(values, op, operand);
    }

    /**
     * Transform every element of an array.
     */
    //% block="map array %values %op %operand"
    //% blockId=ultra_map
    //% operand.defl=2
    //% group="5. Array tools" weight=90
    export function mapBlock(values: any[], op: MathOp, operand: number): any[] {
        return mapArray(values, op, operand);
    }

    /**
     * The number of elements in an array.
     */
    //% block="length of array %values"
    //% blockId=ultra_array_length
    //% group="5. Array tools" weight=85
    export function arrayLengthBlock(values: any[]): number {
        return values == null ? 0 : values.length;
    }

    // -----------------------------------------------------------------
    // 18-20. motors and servos
    // -----------------------------------------------------------------

    /**
     * Choose the two motor driver channels used by the movement blocks.
     */
    //% block="use motors left speed %leftSpeed direction %leftDirection right speed %rightSpeed direction %rightDirection"
    //% blockId=ultra_motor_pins
    //% leftSpeed.defl=AnalogPin.P13 leftDirection.defl=DigitalPin.P14
    //% rightSpeed.defl=AnalogPin.P15 rightDirection.defl=DigitalPin.P16
    //% group="6. Motors" weight=100
    export function motorPinsBlock(leftSpeed: AnalogPin, leftDirection: DigitalPin,
        rightSpeed: AnalogPin, rightDirection: DigitalPin): void {
        configureMotors(leftSpeed, leftDirection, rightSpeed, rightDirection);
    }

    /**
     * Set one motor's PWM speed, 0-255.
     */
    //% block="set motor %pin speed %speed"
    //% blockId=ultra_motor_speed
    //% pin.defl=AnalogPin.P13 speed.min=0 speed.max=255 speed.defl=200
    //% group="6. Motors" weight=95
    export function motorSpeedBlock(pin: AnalogPin, speed: number): void {
        setMotorSpeed(pin, speed);
    }

    /**
     * Set one motor's direction pin.
     */
    //% block="set motor %pin direction %direction"
    //% blockId=ultra_motor_direction
    //% pin.defl=DigitalPin.P14
    //% group="6. Motors" weight=90
    export function motorDirectionBlock(pin: DigitalPin, direction: MotorDirection): void {
        setMotorDirection(pin, direction == MotorDirection.Forward);
    }

    /**
     * Drive both motors: negative values reverse.
     */
    //% block="move left motor %left right motor %right"
    //% blockId=ultra_move
    //% left.min=-255 left.max=255 left.defl=200
    //% right.min=-255 right.max=255 right.defl=180
    //% group="6. Motors" weight=85
    export function moveBlock(left: number, right: number): void {
        move(left, right);
    }

    /**
     * Stop both drive motors.
     */
    //% block="stop motors"
    //% blockId=ultra_stop_motors
    //% group="6. Motors" weight=80
    export function stopMotorsBlock(): void {
        stopMotors();
    }

    /**
     * Position a servo, 0-180 degrees.
     */
    //% block="set servo %pin angle %angle °"
    //% blockId=ultra_servo
    //% pin.defl=AnalogPin.P1 angle.min=0 angle.max=180 angle.defl=90
    //% group="6. Motors" weight=75
    export function servoBlock(pin: AnalogPin, angle: number): void {
        setServo(pin, angle);
    }
}
