/**
 * Radio-controlled robot in JavaScript (features 2, 4, 6, 8, 18-20).
 *
 * Paste js/ultra.js into the project first, then this file. Flash it to the
 * robot; the base station sends command codes:
 *
 *     ultra.start(12);
 *     ultra.setId(9);
 *     ultra.sendCommand(101, 1);   // 1 = robot ID
 */
ultra.start(12);
ultra.setId(1);
ultra.setSenderFilter([9]);          // feature 2
ultra.setSignalThreshold(-85);       // feature 4

ultra.configureMotorPins(AnalogPin.P13, DigitalPin.P14,
    AnalogPin.P15, DigitalPin.P16);  // feature 20
var arm = new ultra.Servo(AnalogPin.P1);   // feature 19

ultra.defineCommand(101, 'turn left');
ultra.defineCommand(102, 'turn right');
ultra.defineCommand(103, 'stop');
ultra.defineCommand(104, 'forward');
ultra.defineCommand(105, 'arm up');
ultra.defineCommand(106, 'arm down');

ultra.onCommand(101, function () {
    ultra.turnLeft(200);
    basic.showString('L');
});

ultra.onCommand(102, function () {
    ultra.turnRight(200);
    basic.showString('R');
});

ultra.onCommand(103, function () {
    ultra.stopMotors();
    basic.showIcon(IconNames.Square);
});

ultra.onCommand(104, function () {
    ultra.forward(255);
    basic.showArrow(ArrowNames.North);
});

ultra.onCommand(105, function () {
    arm.setAngle(180);
});

ultra.onCommand(106, function () {
    arm.setAngle(0);
});

ultra.onMessage(function (message) {
    // Anything else that gets through the filters is shown as text.
    if (message.kind !== ultra.KIND_CODE && message.text.length > 0) {
        basic.showString(message.text);
    }
});

basic.showIcon(IconNames.Yes);
