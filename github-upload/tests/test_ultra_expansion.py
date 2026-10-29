"""Tests for micropython/ultra_expansion.py.

The micro:bit, radio and audio modules are replaced by fakes, so the whole
library runs under CPython. Run with:

    python3 -m unittest discover -s tests -v
"""

import importlib.util
import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, 'micropython', 'ultra_expansion.py')
sys.path.insert(0, os.path.join(ROOT, 'tools'))

from make_melody import encode_mb8, encode_pcm, format_python  # noqa: E402


class FakePin(object):
    def __init__(self, name='pin'):
        self.name = name
        self.analog = None
        self.digital = 0
        self.period_ms = None
        self.period_us = None

    def write_analog(self, value):
        self.analog = value

    def write_digital(self, value):
        self.digital = value

    def read_analog(self):
        return self.analog or 0

    def read_digital(self):
        return self.digital

    def set_analog_period(self, ms):
        self.period_ms = ms

    def set_analog_period_microseconds(self, us):
        self.period_us = us


class FakeRadio(object):
    def __init__(self):
        self.queue = []
        self.sent = []
        self.config_kwargs = None
        self.is_on = False

    def config(self, **kwargs):
        self.config_kwargs = kwargs

    def on(self):
        self.is_on = True

    def off(self):
        self.is_on = False

    def send_bytes(self, data):
        self.sent.append(bytes(data))

    def receive_full(self):
        if not self.queue:
            return None
        raw, rssi = self.queue.pop(0)
        return (raw, rssi, 0)

    def receive_bytes(self):
        packet = self.receive_full()
        if packet is None:
            return None
        return packet[0]


class FakeAudioFrame(object):
    def __init__(self):
        self.data = [0] * 32

    def __setitem__(self, index, value):
        self.data[index] = value

    def __getitem__(self, index):
        return self.data[index]

    def __len__(self):
        return len(self.data)


class FakeAudio(object):
    def __init__(self):
        self.frames = []
        self.playing = False

    def AudioFrame(self):
        return FakeAudioFrame()

    def play(self, source, wait=True, pin=None):
        self.playing = True
        for frame in source:
            self.frames.append(list(frame.data))
        self.playing = False

    def stop(self):
        self.playing = False


def build_microbit():
    module = types.ModuleType('microbit')
    pins = {}
    for number in range(21):
        name = 'pin%d' % number
        pin = FakePin(name)
        pins[name] = pin
        setattr(module, name, pin)
    module.pins = pins
    module.slept = []

    def sleep(ms):
        module.slept.append(ms)

    ticks = [0]

    def running_time():
        ticks[0] += 1
        return ticks[0]

    module.sleep = sleep
    module.running_time = running_time
    return module


def load_library():
    """Import the library against freshly created fake modules."""
    for name in ('microbit', 'radio', 'audio', 'ultra_expansion_ut',
                 'ultra_expansion'):
        sys.modules.pop(name, None)
    microbit = build_microbit()
    radio = FakeRadio()
    audio = FakeAudio()
    sys.modules['microbit'] = microbit
    sys.modules['radio'] = radio
    sys.modules['audio'] = audio
    spec = importlib.util.spec_from_file_location('ultra_expansion_ut', LIB)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # melodies.py does ``from ultra_expansion import register_melody``, so the
    # module under test also has to be reachable under its real name.
    sys.modules['ultra_expansion'] = module
    return module, microbit, radio, audio


class UltraTestCase(unittest.TestCase):
    def setUp(self):
        self.ultra, self.microbit, self.radio, self.audio = load_library()
        self.ultra.start(group=1)

    # -- protocol ---------------------------------------------------------

    def test_pack_unpack_text(self):
        raw = self.ultra.pack(self.ultra.KIND_TEXT, 'hello', 9)
        msg = self.ultra.parse_packet(raw)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.kind, self.ultra.KIND_TEXT)
        self.assertEqual(msg.text, 'hello')
        self.assertEqual(msg.destination, 9)
        self.assertEqual(msg.sender, self.ultra.get_id())

    def test_pack_is_compact(self):
        raw = self.ultra.pack(self.ultra.KIND_TEXT, 'hello', 9)
        self.assertEqual(len(raw), self.ultra.HEADER + 5 + 1)
        self.assertLessEqual(len(raw), 32)

    def test_bad_checksum_is_dropped(self):
        raw = bytearray(self.ultra.pack(self.ultra.KIND_TEXT, 'hello'))
        raw[-1] ^= 0xFF
        self.assertIsNone(self.ultra.parse_packet(bytes(raw)))
        self.assertIsNone(self.ultra.handle(bytes(raw)))

    def test_truncated_and_foreign_packets_are_dropped(self):
        self.assertIsNone(self.ultra.parse_packet(b'\x00\x01'))
        raw = bytearray(self.ultra.pack(self.ultra.KIND_TEXT, 'hi'))
        raw[0] = 0x00
        self.assertIsNone(self.ultra.parse_packet(bytes(raw)))

    def test_payload_is_clamped(self):
        raw = self.ultra.pack(self.ultra.KIND_TEXT, 'x' * 100)
        self.assertEqual(len(raw), self.ultra.HEADER + self.ultra.MAX_PAYLOAD + 1)
        self.assertEqual(self.ultra.parse_packet(raw).text,
                         'x' * self.ultra.MAX_PAYLOAD)

    def test_send_message_uses_radio(self):
        self.ultra.send_message('ping', to=2)
        self.assertTrue(self.radio.sent)
        msg = self.ultra.parse_packet(self.radio.sent[-1])
        self.assertEqual(msg.text, 'ping')
        self.assertEqual(msg.destination, 2)
        self.assertEqual(self.radio.config_kwargs['length'], 32)

    # -- feature 2: sender filtering --------------------------------------

    def test_sender_filter_accepts_known_sender(self):
        self.ultra.set_sender_filter([2])
        raw = self.ultra.pack(self.ultra.KIND_TEXT, 'from two', 0, src=2)
        self.assertIsNotNone(self.ultra.handle(raw, rssi=-60))

    def test_sender_filter_blocks_unknown_sender(self):
        self.ultra.set_sender_filter([2])
        raw = self.ultra.pack(self.ultra.KIND_TEXT, 'from one', 0, src=1)
        self.assertIsNone(self.ultra.handle(raw, rssi=-60))

    def test_clear_sender_filter(self):
        self.ultra.set_sender_filter([2])
        self.ultra.clear_sender_filter()
        raw = self.ultra.pack(self.ultra.KIND_TEXT, 'anyone', 0, src=9)
        self.assertIsNotNone(self.ultra.handle(raw))

    # -- feature 3/4: RSSI and threshold ----------------------------------

    def test_signal_strength_tracks_last_packet(self):
        self.assertEqual(self.ultra.signal_strength(), -100)
        raw = self.ultra.pack(self.ultra.KIND_TEXT, 'x')
        self.ultra.handle(raw, rssi=-55)
        self.assertEqual(self.ultra.signal_strength(), -55)

    def test_threshold_blocks_weak_packets(self):
        self.ultra.set_signal_threshold(-70)
        strong = self.ultra.pack(self.ultra.KIND_TEXT, 'strong')
        weak = self.ultra.pack(self.ultra.KIND_TEXT, 'weak')
        self.assertIsNotNone(self.ultra.handle(strong, rssi=-60))
        self.assertIsNone(self.ultra.handle(weak, rssi=-90))

    def test_signal_handler_only_fires_above_level(self):
        seen = []
        self.ultra.on_signal_above(-70, lambda msg: seen.append(msg.rssi))
        raw = self.ultra.pack(self.ultra.KIND_TEXT, 'x')
        self.ultra.handle(raw, rssi=-80)
        self.ultra.handle(raw, rssi=-50)
        self.assertEqual(seen, [-50])

    # -- feature 5: content filtering -------------------------------------

    def test_content_filter(self):
        self.ultra.set_content_filter('go')
        stop = self.ultra.pack(self.ultra.KIND_TEXT, 'stop')
        go = self.ultra.pack(self.ultra.KIND_TEXT, 'go now')
        self.assertIsNone(self.ultra.handle(stop))
        self.assertIsNotNone(self.ultra.handle(go))

    def test_content_handler(self):
        seen = []
        self.ultra.on_content('LED', lambda msg: seen.append(msg.text))
        self.ultra.handle(self.ultra.pack(self.ultra.KIND_TEXT, 'LED on'))
        self.ultra.handle(self.ultra.pack(self.ultra.KIND_TEXT, 'off'))
        self.assertEqual(seen, ['LED on'])

    # -- feature 6/8: command codes ---------------------------------------

    def test_send_command_payload(self):
        self.ultra.send_command(101)
        msg = self.ultra.parse_packet(self.radio.sent[-1])
        self.assertEqual(msg.kind, self.ultra.KIND_CODE)
        self.assertEqual(msg.code, 101)
        self.assertEqual(msg.text, 'turn left')

    def test_command_dispatches_and_decodes(self):
        self.ultra.define_command(105, 'dance')
        seen = []
        self.ultra.on_command(105, lambda msg: seen.append(msg.code))
        raw = self.ultra.pack(self.ultra.KIND_CODE, '105')
        msg = self.ultra.handle(raw)
        self.assertEqual(msg.text, 'dance')
        self.assertEqual(self.ultra.last_signal(), 105)
        self.assertEqual(seen, [105])
        self.assertEqual(self.ultra.decode_command(105), 'dance')
        self.assertEqual(self.ultra.last_signal(), 105)

    def test_unknown_command(self):
        self.assertEqual(self.ultra.decode_command(999), 'unknown (999)')

    # -- feature 7: function serialisation --------------------------------

    def test_encode_decode_call(self):
        payload = self.ultra.encode_call('drive', (200, -200))
        self.assertEqual(payload, 'drive|200|-200')
        self.assertEqual(self.ultra.decode_call(payload),
                         ('drive', [200, -200]))

    def test_call_escapes_pipe_and_backslash(self):
        payload = self.ultra.encode_call('say', ('a|b', 'c\\d'))
        self.assertEqual(self.ultra.decode_call(payload),
                         ('say', ['a|b', 'c\\d']))

    def test_call_argument_types(self):
        name, args = self.ultra.decode_call('f|1|2.5|hi|True')
        self.assertEqual(name, 'f')
        self.assertEqual(args, [1, 2.5, 'hi', True])

    def test_received_call_invokes_registered_function(self):
        seen = []
        self.ultra.register_function('beep', lambda times: seen.append(times))
        raw = self.ultra.pack(self.ultra.KIND_CALL,
                              self.ultra.encode_call('beep', (3,)))
        self.ultra.handle(raw)
        self.assertEqual(seen, [3])

    def test_send_function_roundtrip(self):
        self.ultra.send_function('wave', 45, to=2)
        msg = self.ultra.parse_packet(self.radio.sent[-1])
        self.assertEqual(msg.name, 'wave')
        self.assertEqual(msg.args, [45])
        self.assertEqual(msg.destination, 2)

    def test_call_errors_are_captured_not_raised(self):
        def explode():
            raise ValueError('boom')

        self.ultra.register_function('explode', explode)
        raw = self.ultra.pack(self.ultra.KIND_CALL,
                              self.ultra.encode_call('explode', ()))
        self.ultra.handle(raw)
        self.assertEqual(str(self.ultra.last_error()), 'boom')

    # -- feature 9/10/11: variables ---------------------------------------

    def test_unpack(self):
        self.assertEqual(self.ultra.unpack([1, 2, 3]), (1, 2, 3))
        self.assertEqual(self.ultra.unpack([1], 3), (1, None, None))
        self.assertEqual(self.ultra.unpack([1], 2, pad=0), (1, 0))

    def test_unpack_into_named_variables(self):
        self.ultra.unpack_into(['px', 'py', 'pz'], [4, 5, 6])
        self.assertEqual((self.ultra.px, self.ultra.py, self.ultra.pz),
                         (4, 5, 6))

    def test_make_variables_from_dict(self):
        made = self.ultra.make_variables({'speed': 120, 'name': 'bot'})
        self.assertEqual(self.ultra.speed, 120)
        self.assertEqual(self.ultra.name, 'bot')
        self.assertEqual(made['speed'], 120)

    def test_make_variables_from_array_and_pairs(self):
        self.ultra.make_variables([10, 20])
        self.assertEqual(self.ultra.__dict__['0'], 10)
        self.ultra.make_variables([['x', 1], ['y', 2]])
        self.assertEqual((self.ultra.x, self.ultra.y), (1, 2))

    def test_array_to_object_with_names(self):
        player = self.ultra.array_to_object([100, 3, 'sam'],
                                            ['score', 'lives', 'name'])
        self.assertEqual(player.score, 100)
        self.assertEqual(player['lives'], 3)
        self.assertEqual(player.name, 'sam')
        self.assertEqual(sorted(player.keys()), ['lives', 'name', 'score'])
        self.assertEqual(player.to_dict()['score'], 100)
        player.score = 250
        self.assertEqual(player.score, 250)
        self.assertIn('name', player)

    def test_array_to_object_from_pairs(self):
        obj = self.ultra.array_to_object([['x', 1], ['y', 2]])
        self.assertEqual((obj.x, obj.y), (1, 2))

    def test_array_to_object_default_names(self):
        obj = self.ultra.array_to_object([7, 8])
        self.assertEqual((obj.item0, obj.item1), (7, 8))

    # -- feature 12/13/14: resets -----------------------------------------

    def test_reset_var_uses_sensible_defaults(self):
        self.ultra.counter = 12
        self.ultra.label = 'hi'
        self.ultra.items = [1, 2]
        self.assertEqual(self.ultra.reset_var('counter'), 0)
        self.assertEqual(self.ultra.reset_var('label'), '')
        self.assertEqual(self.ultra.reset_var('items'), [])
        self.assertEqual(self.ultra.counter, 0)

    def test_reset_var_custom_value(self):
        self.ultra.counter = 12
        self.assertEqual(self.ultra.reset_var('counter', 99), 99)
        self.assertEqual(self.ultra.counter, 99)

    def test_reset_array(self):
        values = [1, 2, 3]
        returned = self.ultra.reset_array(values)
        self.assertIs(returned, values)
        self.assertEqual(values, [])

    def test_clear_variables_keeps_library_intact(self):
        self.ultra.alpha = 1
        self.ultra.beta = 'two'
        removed = self.ultra.clear_variables()
        self.assertIn('alpha', removed)
        self.assertIn('beta', removed)
        self.assertFalse(hasattr(self.ultra, 'alpha'))
        self.assertEqual(self.ultra.decode_command(101), 'turn left')
        self.assertTrue(callable(self.ultra.play_melody))
        self.assertEqual(self.ultra.VERSION, 1)

    def test_clear_variables_honours_keep(self):
        self.ultra.alpha = 1
        self.ultra.beta = 2
        self.ultra.clear_variables(keep=['alpha'])
        self.assertEqual(self.ultra.alpha, 1)
        self.assertFalse(hasattr(self.ultra, 'beta'))

    # -- feature 15/16/17: sorting, filtering, mapping --------------------

    def test_sort_array(self):
        self.assertEqual(self.ultra.sort_array([3, 1, 2]), [1, 2, 3])
        self.assertEqual(self.ultra.sort_array([3, 1, 2], descending=True),
                         [3, 2, 1])
        self.assertEqual(self.ultra.sort_array(['pear', 'apple']),
                         ['apple', 'pear'])

    def test_sort_mixed_array_falls_back_to_text(self):
        self.assertEqual(self.ultra.sort_array([2, 'a', 1]), [1, 2, 'a'])

    def test_sort_in_place(self):
        values = [3, 1, 2]
        self.ultra.sort_array_in_place(values)
        self.assertEqual(values, [1, 2, 3])

    def test_filter_array(self):
        values = [1, 2, 3, 4, 5]
        self.assertEqual(self.ultra.filter_array(values, self.ultra.gt(2)),
                         [3, 4, 5])
        self.assertEqual(self.ultra.filter_array(values, self.ultra.is_even),
                         [2, 4])
        self.assertEqual(self.ultra.filter_array(values,
                                                self.ultra.between(2, 4)),
                         [2, 3, 4])

    def test_filter_original_is_untouched(self):
        values = [1, 2, 3]
        self.ultra.filter_array(values, self.ultra.gt(1))
        self.assertEqual(values, [1, 2, 3])

    def test_map_array(self):
        values = [1, 2, 3]
        self.assertEqual(self.ultra.map_array(values, self.ultra.multiply(2)),
                         [2, 4, 6])
        self.assertEqual(self.ultra.map_array(values, self.ultra.add(10)),
                         [11, 12, 13])

    def test_map_range_and_clamp(self):
        scaled = self.ultra.map_array([0, 512, 1023],
                                      self.ultra.map_range(0, 1023, 0, 255))
        self.assertEqual([int(v) for v in scaled], [0, 127, 255])
        self.assertEqual(self.ultra.map_array([-5, 5, 50],
                                              self.ultra.clamp(0, 10)),
                         [0, 5, 10])

    # -- feature 1: melodies ----------------------------------------------

    def test_mb8_roundtrip_is_exact_for_small_steps(self):
        samples = []
        level = 0
        while level < 120:
            samples.append(level)
            level += 3
        data = encode_mb8(samples, 0)
        decoded = self.ultra.decode_mb8(data)
        self.assertEqual(len(decoded), len(samples) + (len(samples) % 2))
        for i, sample in enumerate(samples):
            self.assertEqual(decoded[i], sample + 128)

    def test_mb8_metadata(self):
        data = encode_mb8([0] * 2000, 0)
        self.assertTrue(self.ultra.is_mb8(data))
        self.assertEqual(self.ultra.mb8_rate(data), 7812)
        self.assertGreater(self.ultra.mb8_duration(data), 200)

    def test_decode_rejects_foreign_data(self):
        with self.assertRaises(ValueError):
            self.ultra.decode_mb8(b'WAVE....')

    def test_registry_and_playback(self):
        samples = encode_pcm([0, 60, 0, -60] * 300, 7812, 7812)
        self.ultra.register_melody('test', samples)
        self.assertTrue(self.ultra.has_melody('test'))
        self.assertIn('test', self.ultra.melody_names())
        self.assertEqual(self.ultra.melody_size('test'), len(samples))
        self.ultra.play_melody('test')
        expected = len(self.ultra.decode_mb8(samples))
        self.assertGreaterEqual(len(self.audio.frames), expected // 32)
        self.assertLessEqual(len(self.audio.frames), expected // 32 + 2)
        for frame in self.audio.frames:
            self.assertEqual(len(frame), 32)
            for value in frame:
                self.assertTrue(0 <= value <= 255)

    def test_play_unknown_melody_raises(self):
        with self.assertRaises(ValueError):
            self.ultra.play_melody('missing')

    def test_register_rejects_bad_format(self):
        with self.assertRaises(ValueError):
            self.ultra.register_melody('bad', b'OggS....')

    def test_generated_python_snippet_roundtrips(self):
        data = encode_mb8([0, 40, -40] * 32, 0)
        snippet = format_python('demo', data)
        captured = {}

        def register_melody(name, payload):
            captured['name'] = name
            captured['data'] = payload

        exec(snippet, {'register_melody': register_melody})
        self.assertEqual(captured['name'], 'demo')
        self.assertEqual(captured['data'], data)

    def test_shipped_melody_bank_loads(self):
        with open(os.path.join(ROOT, 'micropython', 'melodies.py'),
                  encoding='utf-8') as handle:
            source = handle.read()
        scope = {'register_melody': self.ultra.register_melody}
        exec(compile(source, 'melodies.py', 'exec'), scope)
        self.assertIn('startup', self.ultra.melody_names())
        self.ultra.play_melody('startup')
        self.assertTrue(self.audio.frames)

    # -- feature 18/19/20: motors and servos ------------------------------

    def test_motor_speed_maps_to_pwm(self):
        speed_pin = self.microbit.pin13
        motor = self.ultra.Motor(speed_pin)
        motor.set_speed(255)
        self.assertEqual(speed_pin.analog, 1023)
        motor.set_speed(128)
        self.assertEqual(speed_pin.analog, 513)
        motor.set_speed(1000)
        self.assertEqual(motor.speed(), 255)

    def test_motor_direction_pin(self):
        speed_pin = self.microbit.pin13
        direction_pin = self.microbit.pin14
        motor = self.ultra.Motor(speed_pin, direction_pin)
        motor.set_direction('forward')
        self.assertEqual(direction_pin.digital, 1)
        motor.set_direction('backward')
        self.assertEqual(direction_pin.digital, 0)
        motor.drive(-100)
        self.assertEqual(direction_pin.digital, 0)
        self.assertEqual(speed_pin.analog, 401)

    def test_motor_invert_and_stop(self):
        speed_pin = self.microbit.pin15
        direction_pin = self.microbit.pin16
        motor = self.ultra.Motor(speed_pin, direction_pin, invert=True)
        motor.set_direction(True)
        self.assertEqual(direction_pin.digital, 0)
        motor.set_speed(200)
        motor.stop()
        self.assertEqual(speed_pin.analog, 0)
        motor.brake()
        self.assertEqual(direction_pin.digital, 1)

    def test_servo_angle_to_pulse(self):
        pin = self.microbit.pin1
        servo = self.ultra.Servo(pin)
        self.assertEqual(pin.period_ms, 20)
        servo.set_angle(90, smooth=False)
        self.assertEqual(servo.angle(), 90)
        self.assertEqual(pin.analog, int(1500 * 1023 // 20000))
        servo.set_angle(0, smooth=False)
        self.assertEqual(pin.analog, int(500 * 1023 // 20000))
        servo.set_angle(180, smooth=False)
        self.assertEqual(pin.analog, int(2500 * 1023 // 20000))

    def test_servo_clamps_and_centers(self):
        servo = self.ultra.Servo(self.microbit.pin2, step_delay=0)
        servo.set_angle(400, smooth=False)
        self.assertEqual(servo.angle(), 180)
        servo.set_angle(-20, smooth=False)
        self.assertEqual(servo.angle(), 0)
        servo.center()
        self.assertEqual(servo.angle(), 90)

    def test_chassis_move_and_turns(self):
        left = self.ultra.Motor(self.microbit.pin13, self.microbit.pin14)
        right = self.ultra.Motor(self.microbit.pin15, self.microbit.pin16)
        self.ultra.set_motors(left, right)
        self.assertEqual(self.ultra.move(200, 180), (200, 180))
        self.assertEqual(left.speed(), 200)
        self.assertEqual(right.speed(), 180)
        self.assertTrue(left.direction())
        self.ultra.turn_left(150)
        self.assertFalse(left.direction())
        self.assertTrue(right.direction())
        self.ultra.forward(255)
        self.assertEqual((left.speed(), right.speed()), (255, 255))
        self.ultra.stop_motors()
        self.assertEqual((left.speed(), right.speed()), (0, 0))

    def test_set_motor_pins_helper(self):
        chassis = self.ultra.set_motor_pins(self.microbit.pin13,
                                           self.microbit.pin14,
                                           self.microbit.pin15,
                                           self.microbit.pin16)
        self.assertEqual(chassis.move(100, 100), (100, 100))

    def test_move_without_motors_raises(self):
        with self.assertRaises(ValueError):
            self.ultra.move(100, 100)

    # -- housekeeping ------------------------------------------------------

    def test_status_and_reset_all(self):
        self.ultra.set_id(7)
        self.ultra.set_sender_filter([1])
        self.ultra.on_message(lambda msg: None)
        status = self.ultra.status()
        self.assertEqual(status['id'], 7)
        self.assertEqual(status['sender_filter'], [1])
        self.assertEqual(status['handlers'], 1)
        self.ultra.reset_all()
        self.assertEqual(self.ultra.status()['handlers'], 0)
        self.assertEqual(self.ultra.status()['sender_filter'], [])
        self.assertEqual(self.ultra.status()['threshold'], -128)

    def test_poll_drains_queue(self):
        seen = []
        self.ultra.on_message(lambda msg: seen.append(msg.text))
        self.radio.queue.append((self.ultra.pack(self.ultra.KIND_TEXT, 'one'),
                                 -60))
        self.radio.queue.append((self.ultra.pack(self.ultra.KIND_TEXT, 'two'),
                                 -60))
        self.assertEqual(self.ultra.poll(), 2)
        self.assertEqual(seen, ['one', 'two'])
        self.assertEqual(self.ultra.poll(), 0)


if __name__ == '__main__':
    unittest.main()
