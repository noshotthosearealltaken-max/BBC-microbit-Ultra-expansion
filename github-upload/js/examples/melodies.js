/**
 * Melody player in JavaScript (feature 1).
 *
 * Two ways to register a melody:
 *   - note strings, played at full quality by music.playMelody
 *   - MB8 bytes from the converter, played through pins.analogPitch
 *     (JavaScript cannot stream PCM to the micro:bit DAC)
 *
 * Paste js/ultra.js into the project first, then this file.
 */
ultra.registerMelody('startup', 'c5 e5 g5 c6', 150);
ultra.registerMelody('coin', 'b5 e6', 300);
ultra.registerMelody('alarm', 'a5 r a5 r a5 r a5', 240);

// A tiny MB8 blip: 0x4D 'M', 0x42 'B', 0x38 '8', version 1, 7812 Hz,
// then 4-bit delta samples (the converter writes longer ones).
var blip = [
    0x4D, 0x42, 0x38, 0x01, 0x00,
    0xF0, 0xFF, 0x0F, 0x00, 0xF0, 0x0F, 0x00, 0xFF, 0x00
];
ultra.registerMelodyData('blip', blip);

var names = ultra.melodyNames();
var index = 0;

input.onButtonPressed(Button.A, function () {
    ultra.playMelody(names[index]);
    basic.showString(names[index]);
    index = (index + 1) % names.length;
});

input.onButtonPressed(Button.B, function () {
    ultra.playMelody('blip');
});

input.onGesture(Gesture.Shake, function () {
    ultra.stopMelody();
});

basic.showIcon(IconNames.EighthNote);
