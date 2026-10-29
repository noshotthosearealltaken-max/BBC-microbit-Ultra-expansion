"""Ultra Expansion Pack for the BBC micro:bit - MicroPython runtime.

Twenty features in a single importable module:

     1  MP3 -> MB8 melody upload and playback
     2  sender-ID radio filtering
     3  RSSI signal strength
     4  signal-strength threshold triggering
     5  message content filtering
     6  numeric command codes
     7  function serialisation and transmission
     8  command code decoder
     9  array -> variables (unpacking)
    10  dynamic variables from array keys
    11  array -> object conversion
    12  variable reset
    13  array reset
    14  bulk variable reset
    15  array sorting
    16  array filtering
    17  array mapping
    18  motor speed and direction (PWM)
    19  servo angle control
    20  dual-motor coordination

Quick start
-----------
    import ultra_expansion as ultra
    ultra.start(group=1)
    ultra.set_id(3)

    @ultra.on_sender(1)
    def from_base(msg):
        display.scroll(msg.text)

    ultra.run()

Wire format
-----------
Every packet is:

    0xE7 | ver<<4 | kind | src | dst | seq | len | payload... | xor checksum

``kind`` is 0 text, 1 command code, 2 serialised function call, 3 raw bytes.
A payload of at most 24 bytes keeps every packet inside the radio's standard
32 byte frame, so no firmware tuning is needed.

The MakeCode companion (see ``ultra.ts``) speaks this exact byte format, so
MakeCode boards and MicroPython boards can talk to each other.
"""

from microbit import *
import radio

try:
    import audio as _audio
    _HAS_AUDIO = True
except ImportError:          # micro:bit v1 has no audio module
    _audio = None
    _HAS_AUDIO = False

__version__ = '1.0.0'

# ---------------------------------------------------------------------------
# Protocol constants
# ---------------------------------------------------------------------------

BROADCAST = 255
MAGIC = 0xE7
VERSION = 1
HEADER = 6
MAX_PAYLOAD = 24

KIND_TEXT = 0
KIND_CODE = 1
KIND_CALL = 2
KIND_RAW = 3

# Radio defaults, chosen to match the radio blocks in MakeCode.
DEFAULT_GROUP = 1
DEFAULT_CHANNEL = 7
DEFAULT_POWER = 6

# ---------------------------------------------------------------------------
# Internal state
# ---------------------------------------------------------------------------

_started = False
_self_id = 1
_seq = 0
_last_rssi = -100
_last_msg = None
_last_error = None
_last_signal = 0
_has_full = hasattr(radio, 'receive_full')

_sender_filter = []          # empty list means "accept everybody"
_signal_threshold = -128
_content_filter = ''

_handlers = []               # list of [tag, value, function]
_commands = {101: 'turn left', 102: 'turn right', 103: 'stop', 104: 'forward'}
_functions = {}              # name -> callable, used by KIND_CALL packets
_melodies = {}               # name -> MB8 bytes

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _checksum(buf):
    """XOR checksum of a bytes-like object."""
    value = 0
    for b in buf:
        value ^= b
    return value & 0xFF


def _escape(text):
    return text.replace('\\', '\\\\').replace('|', '\\|')


def _split_escaped(text):
    parts = []
    current = []
    escaped = False
    for ch in text:
        if escaped:
            current.append(ch)
            escaped = False
        elif ch == '\\':
            escaped = True
        elif ch == '|':
            parts.append(''.join(current))
            current = []
        else:
            current.append(ch)
    parts.append(''.join(current))
    return parts


def _literal(text):
    """Turn a serialised argument back into int, float or str."""
    if text == 'True':
        return True
    if text == 'False':
        return False
    if text == 'None':
        return None
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        pass
    return text


def _bytes(value):
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    return str(value).encode()


def _textify(value):
    if isinstance(value, str):
        return value
    try:
        return bytes(value).decode()
    except (AttributeError, UnicodeError):
        return str(value)


# ---------------------------------------------------------------------------
# Packet packing / unpacking
# ---------------------------------------------------------------------------

class Message(object):
    """A decoded radio packet plus its metadata."""

    __slots__ = ('kind', 'sender', 'destination', 'seq', 'rssi', 'payload',
                 'text', 'code', 'name', 'args', 'time')

    def __init__(self):
        self.kind = KIND_TEXT
        self.sender = 0
        self.destination = 0
        self.seq = 0
        self.rssi = -100
        self.payload = b''
        self.text = ''
        self.code = 0
        self.name = ''
        self.args = []
        self.time = 0

    def __repr__(self):
        return '<Message kind=%d from=%d rssi=%d text=%r>' % (
            self.kind, self.sender, self.rssi, self.text)


def pack(kind, payload, to_id=0, src=None, seq=None):
    """Build an Ultra packet. Used by every send_* helper."""
    global _seq
    payload = _bytes(payload)
    if len(payload) > MAX_PAYLOAD:
        payload = payload[:MAX_PAYLOAD]
    if src is None:
        src = _self_id
    if seq is None:
        seq = _seq
        _seq = (_seq + 1) & 0xFF
    body = bytearray(HEADER + len(payload) + 1)
    body[0] = MAGIC
    body[1] = (VERSION << 4) | (kind & 0x0F)
    body[2] = src & 0xFF
    body[3] = to_id & 0xFF
    body[4] = seq & 0xFF
    body[5] = len(payload)
    for i in range(len(payload)):
        body[HEADER + i] = payload[i]
    body[len(body) - 1] = _checksum(body[:len(body) - 1])
    return bytes(body)


def parse_packet(raw):
    """Decode a packet, returning a Message or None if it is not valid."""
    try:
        raw = bytes(raw)
    except TypeError:
        return None
    if len(raw) < HEADER + 1 or raw[0] != MAGIC:
        return None
    if (raw[1] >> 4) != VERSION:
        return None
    length = raw[5]
    if length > len(raw) - HEADER - 1:
        return None
    end = HEADER + length
    if raw[end] != _checksum(raw[:end]):
        return None
    msg = Message()
    msg.kind = raw[1] & 0x0F
    msg.sender = raw[2]
    msg.destination = raw[3]
    msg.seq = raw[4]
    msg.payload = raw[HEADER:end]
    msg.text = _textify(msg.payload)
    if msg.kind == KIND_CODE:
        try:
            msg.code = int(msg.text)
        except ValueError:
            msg.code = -1
        msg.text = _commands.get(msg.code, msg.text)
    elif msg.kind == KIND_CALL:
        msg.name, msg.args = decode_call(msg.payload)
        msg.text = msg.name
    return msg


# ---------------------------------------------------------------------------
# Feature 2-8: radio, filtering, codes, calls
# ---------------------------------------------------------------------------

def start(group=DEFAULT_GROUP, channel=DEFAULT_CHANNEL, power=DEFAULT_POWER,
          queue=16, length=32):
    """Turn the radio on with Ultra defaults."""
    global _started
    radio.config(group=group, channel=channel, power=power, queue=queue,
                 length=length)
    radio.on()
    _started = True
    return True


def stop():
    """Switch the radio off."""
    global _started
    radio.off()
    _started = False


def _ensure_started():
    if not _started:
        start()


def set_id(microbit_id):
    """Set this board's sender ID (1-254)."""
    global _self_id
    microbit_id = int(microbit_id)
    if microbit_id < 0 or microbit_id > 255:
        raise ValueError('id must be 0-255')
    _self_id = microbit_id
    return _self_id


def get_id():
    return _self_id


def signal_strength():
    """Feature 3: RSSI of the last packet in dBm (-100 weak ... 0 strong)."""
    return _last_rssi


def last_message():
    return _last_msg


def last_signal():
    return _last_signal


def last_error():
    return _last_error


def set_sender_filter(ids):
    """Feature 2: only accept packets from these sender IDs."""
    global _sender_filter
    if ids is None:
        _sender_filter = []
    elif isinstance(ids, (list, tuple)):
        _sender_filter = list(ids)
    else:
        _sender_filter = [ids]
    return _sender_filter


def add_sender(microbit_id):
    if microbit_id not in _sender_filter:
        _sender_filter.append(microbit_id)


def clear_sender_filter():
    set_sender_filter(None)


def set_signal_threshold(dbm):
    """Feature 4: ignore packets weaker than ``dbm``."""
    global _signal_threshold
    _signal_threshold = int(dbm)
    return _signal_threshold


def set_content_filter(pattern):
    """Feature 5: only accept packets whose text contains ``pattern``."""
    global _content_filter
    _content_filter = str(pattern)
    return _content_filter


def clear_filters():
    global _signal_threshold, _content_filter
    set_sender_filter(None)
    _signal_threshold = -128
    _content_filter = ''


def define_command(code, label):
    """Feature 8: give a numeric code a human readable name."""
    _commands[int(code)] = str(label)
    return label


def command_name(code):
    return _commands.get(int(code), str(code))


def decode_command(code):
    """Feature 8 block: turn a received code into readable text."""
    try:
        code = int(code)
    except (TypeError, ValueError):
        return str(code)
    return _commands.get(code, 'unknown (%d)' % code)


def send(raw):
    """Send an already packed Ultra packet."""
    _ensure_started()
    radio.send_bytes(raw)
    return raw


def send_message(text, to=None):
    """Feature 5/6: send a text packet (``to=None`` broadcasts)."""
    target = BROADCAST if to is None else int(to)
    return send(pack(KIND_TEXT, text, target))


def broadcast(text):
    return send_message(text, None)


def send_command(code, to=None):
    """Feature 6: send a numeric command code instead of a string."""
    target = BROADCAST if to is None else int(to)
    return send(pack(KIND_CODE, str(int(code)), target))


def encode_call(name, args):
    """Feature 7: serialise a function name plus arguments into text."""
    parts = [_escape(str(name))]
    for arg in args:
        parts.append(_escape(str(arg)))
    return '|'.join(parts)


def decode_call(payload):
    """Feature 7: rebuild ``(name, args)`` from a serialised call."""
    parts = _split_escaped(_textify(payload))
    if not parts:
        return ('', [])
    name = parts[0]
    args = [_literal(part) for part in parts[1:]]
    return (name, args)


def send_function(name, *args, **kwargs):
    """Feature 7: transmit a call, e.g. ``send_function('drive', 200, -200)``."""
    to = kwargs.get('to', None)
    target = BROADCAST if to is None else int(to)
    payload = encode_call(name, args)
    return send(pack(KIND_CALL, payload, target))


def register_function(name, function):
    """Make ``name`` callable when a KIND_CALL packet arrives."""
    _functions[str(name)] = function
    return function


def unregister_function(name):
    _functions.pop(str(name), None)


def send_raw(data, to=None):
    target = BROADCAST if to is None else int(to)
    return send(pack(KIND_RAW, data, target))


def on_message(function):
    """Call ``function(msg)`` for every accepted packet."""
    _handlers.append(['any', None, function])
    return function


def on_sender(sender_id, function):
    """Feature 2 block: on radio received [from sender ID]."""
    _handlers.append(['sender', sender_id, function])
    return function


def on_signal_above(dbm, function):
    """Feature 4 block: on radio received [if signal strength > dbm]."""
    _handlers.append(['signal', int(dbm), function])
    return function


def on_content(pattern, function):
    """Feature 5 block: receive signal [containing: pattern]."""
    _handlers.append(['content', str(pattern), function])
    return function


def on_command(code, function):
    """Feature 6 block: on command code received."""
    _handlers.append(['command', int(code), function])
    return function


def off_handlers(function=None):
    """Remove one handler, or all of them when called without arguments."""
    global _handlers
    if function is None:
        _handlers = []
        return
    kept = []
    for entry in _handlers:
        if entry[2] != function:
            kept.append(entry)
    _handlers = kept


def _dispatch(msg):
    for entry in _handlers:
        tag = entry[0]
        value = entry[1]
        function = entry[2]
        try:
            accept = False
            if tag == 'any':
                accept = True
            elif tag == 'sender':
                if isinstance(value, (list, tuple)):
                    accept = msg.sender in value
                else:
                    accept = msg.sender == value
            elif tag == 'signal':
                accept = msg.rssi >= value
            elif tag == 'content':
                accept = value in msg.text
            elif tag == 'command':
                accept = msg.kind == KIND_CODE and msg.code == value
            if accept:
                function(msg)
        except Exception as error:       # keep the event loop alive
            global _last_error
            _last_error = error


def _receive_one():
    if _has_full:
        packet = radio.receive_full()
        if packet is None:
            return None
        return (packet[0], packet[1])
    raw = radio.receive_bytes()
    if raw is None:
        return None
    return (raw, _last_rssi)


def handle(raw, rssi=None):
    """Run one packet through the filters and handlers (used by tests)."""
    global _last_rssi, _last_msg, _last_signal, _last_error
    msg = parse_packet(raw)
    if msg is None:
        return None
    if rssi is None:
        rssi = _last_rssi
    msg.rssi = rssi
    msg.time = running_time()
    _last_rssi = rssi
    _last_msg = msg
    if _sender_filter and msg.sender not in _sender_filter:
        return None
    if rssi < _signal_threshold:
        return None
    if _content_filter and _content_filter not in msg.text:
        return None
    if msg.kind == KIND_CODE:
        _last_signal = msg.code
    elif msg.kind == KIND_CALL:
        function = _functions.get(msg.name)
        if function is not None:
            try:
                function(*msg.args)
            except Exception as error:
                _last_error = error
    _dispatch(msg)
    return msg


def poll(limit=4):
    """Process up to ``limit`` queued packets, returning how many arrived."""
    count = 0
    while count < limit:
        packet = _receive_one()
        if packet is None:
            break
        handle(packet[0], packet[1])
        count += 1
    return count


def run(idle=20):
    """Feature 2-8 event loop: poll forever, sleeping ``idle`` ms between passes."""
    while True:
        poll()
        sleep(idle)


# ---------------------------------------------------------------------------
# Feature 1: MB8 melody playback
# ---------------------------------------------------------------------------

MB8_RATES = (7812, 8000, 11025, 16000, 22050, 4000)
MB8_HEADER = 5


def is_mb8(data):
    return len(data) > MB8_HEADER and data[0:3] == b'MB8'


def mb8_rate(data):
    if not is_mb8(data):
        return 7812
    code = data[4] & 0x0F
    if code < len(MB8_RATES):
        return MB8_RATES[code]
    return 7812


def mb8_duration(data):
    """Length of an MB8 melody in milliseconds."""
    if not is_mb8(data):
        return 0
    samples = (len(data) - MB8_HEADER) * 2
    return samples * 1000 // mb8_rate(data)


def decode_mb8(data):
    """Decode MB8 nibble-delta audio into unsigned samples (128 = silence)."""
    if not is_mb8(data):
        raise ValueError('not MB8 melody data')
    level = 128
    out = bytearray((len(data) - MB8_HEADER) * 2)
    index = 0
    for byte in data[MB8_HEADER:]:
        low = byte & 0x0F
        high = (byte >> 4) & 0x0F
        level += low - 8
        if level < 0:
            level = 0
        elif level > 255:
            level = 255
        out[index] = level
        index += 1
        level += high - 8
        if level < 0:
            level = 0
        elif level > 255:
            level = 255
        out[index] = level
        index += 1
    return out


def register_melody(name, data):
    """Feature 1: make a melody playable by name."""
    data = bytes(data)
    if not is_mb8(data):
        raise ValueError('melody data must start with MB8')
    _melodies[str(name)] = data
    return name


def melody_names():
    return list(_melodies.keys())


def melody_size(name):
    return len(_melodies[name])


def melody_duration(name):
    """Length of a registered melody in milliseconds."""
    return mb8_duration(_melodies[name])


def has_melody(name):
    return name in _melodies


def _audio_frames(samples, rate=7812):
    """Yield 32 sample AudioFrames, resampling to the micro:bit's 7812.5 Hz."""
    total = len(samples)
    step = float(rate) / 7812.5
    frame = _audio.AudioFrame()
    position = 0.0
    while True:
        if int(position) >= total:
            return
        for i in range(32):
            index = int(position)
            if index < total:
                frame[i] = samples[index]
            else:
                frame[i] = 128
            position += step
        yield frame


def _pitch_play(samples, rate, wait=True):
    """micro:bit v1 fallback: follow the melody's loudness with the buzzer."""
    try:
        import music
    except ImportError:
        return
    total = len(samples)
    block = rate // 25
    if block < 1:
        block = 1
    index = 0
    while index < total:
        end = index + block
        if end > total:
            end = total
        energy = 0
        count = 0
        while index < end:
            value = samples[index] - 128
            if value < 0:
                value = -value
            energy += value
            count += 1
            index += 1
        amplitude = energy // count if count else 0
        if amplitude > 4:
            music.pitch(180 + amplitude * 8, 40)
        else:
            sleep(40)


def play_melody(name, wait=True):
    """Feature 1 block: play melody [name]."""
    data = _melodies.get(name)
    if data is None:
        raise ValueError('unknown melody: %s' % name)
    samples = decode_mb8(data)
    rate = mb8_rate(data)
    if _HAS_AUDIO:
        _audio.play(_audio_frames(samples, rate), wait=wait)
    else:
        _pitch_play(samples, rate, wait)


def stop_melody():
    if _HAS_AUDIO:
        _audio.stop()


# ---------------------------------------------------------------------------
# Features 9-14: variables and arrays
# ---------------------------------------------------------------------------

def unpack(array, count=None, pad=None):
    """Feature 9: pull ``count`` values out of an array.

    ``x, y, z = ultra.unpack(values, 3)`` works with lists, tuples,
    bytearrays and array.array objects.
    """
    if count is None:
        return tuple(array)
    out = []
    length = len(array)
    for i in range(count):
        if i < length:
            out.append(array[i])
        else:
            out.append(pad)
    return tuple(out)


def unpack_into(names, array, pad=None):
    """Feature 9 block: set [x, y, z] from array [my_array]."""
    names = list(names)
    values = unpack(array, len(names), pad)
    scope = globals()
    for i in range(len(names)):
        scope[str(names[i])] = values[i]
    return values


def make_variables(mapping, prefix=''):
    """Feature 10: create globals from an array, dict or list of pairs."""
    scope = globals()
    pairs = []
    if isinstance(mapping, dict):
        for key in mapping:
            pairs.append((key, mapping[key]))
    else:
        for index in range(len(mapping)):
            item = mapping[index]
            if isinstance(item, (list, tuple)) and len(item) == 2:
                pairs.append((item[0], item[1]))
            else:
                pairs.append((index, item))
    made = {}
    for key, value in pairs:
        name = str(prefix) + str(key)
        scope[name] = value
        made[name] = value
    return made


def _default_for(value):
    if value is None:
        return 0
    if isinstance(value, str):
        return ''
    if isinstance(value, (list, bytearray)):
        return type(value)()
    if isinstance(value, dict):
        return {}
    if isinstance(value, tuple):
        return ()
    if isinstance(value, bool):
        return False
    return 0


def reset_var(name, value=None):
    """Feature 12 block: reset variable [my_var]."""
    scope = globals()
    if value is None:
        value = _default_for(scope.get(name))
    scope[str(name)] = value
    return value


def reset_array(array):
    """Feature 13 block: reset array [my_array] (in place, length 0)."""
    try:
        del array[:]
    except AttributeError:
        return array
    return array


def clear_variables(keep=None):
    """Feature 14 block: clear all variables.

    Only plain data globals are removed. Functions, classes, modules,
    UPPERCASE constants and names starting with ``_`` survive, so the
    library keeps working.
    """
    scope = globals()
    protected = []
    if keep:
        protected = [str(name) for name in keep]
    removed = []
    for name in list(scope.keys()):
        if name.startswith('_') or name.isupper() or name in protected:
            continue
        value = scope[name]
        if value is None or isinstance(value, (int, float, str, list, dict,
                                               tuple, bytearray, bytes)):
            removed.append(name)
    for name in removed:
        del scope[name]
    return removed


class DataObject(object):
    """Feature 11: a small object with named properties."""

    def __init__(self, data=None, **kwargs):
        object.__setattr__(self, '_data', {})
        if isinstance(data, dict):
            for key in data:
                self._data[str(key)] = data[key]
        elif data is not None:
            for index in range(len(data)):
                item = data[index]
                if isinstance(item, (list, tuple)) and len(item) == 2:
                    self._data[str(item[0])] = item[1]
                else:
                    self._data['item%d' % index] = item
        for key in kwargs:
            self._data[key] = kwargs[key]

    def __getattr__(self, name):
        try:
            return self._data[name]
        except KeyError:
            raise AttributeError(name)

    def __setattr__(self, name, value):
        self._data[name] = value

    def __getitem__(self, key):
        return self._data[str(key)]

    def __setitem__(self, key, value):
        self._data[str(key)] = value

    def __delitem__(self, key):
        del self._data[str(key)]

    def __contains__(self, key):
        return str(key) in self._data

    def __len__(self):
        return len(self._data)

    def __iter__(self):
        return iter(self._data)

    def keys(self):
        return list(self._data.keys())

    def values(self):
        return list(self._data.values())

    def items(self):
        out = []
        for key in self._data:
            out.append((key, self._data[key]))
        return out

    def get(self, key, default=None):
        return self._data.get(str(key), default)

    def to_dict(self):
        return dict(self._data)

    def __repr__(self):
        return '<DataObject %r>' % (self._data,)


def array_to_object(array, names=None):
    """Feature 11 block: array [my_array] to object [player_data].

    ``names`` may be a list of property names or ``None`` to use ``item0``,
    ``item1``... Pairs such as ``[['x', 1], ['y', 2]]`` become ``x``/``y``.
    """
    if isinstance(array, DataObject):
        return array
    if names is None:
        if isinstance(array, dict):
            return DataObject(array)
        return DataObject(array)
    values = list(array)
    data = {}
    for index in range(len(names)):
        if index < len(values):
            data[str(names[index])] = values[index]
        else:
            data[str(names[index])] = None
    return DataObject(data)


def _sort_by_text(values, descending):
    """Insertion sort by ``str()`` for mixed arrays (MicroPython has no key=)."""
    ordered = list(values)
    for i in range(1, len(ordered)):
        item = ordered[i]
        key = str(item)
        j = i - 1
        while j >= 0 and str(ordered[j]) > key:
            ordered[j + 1] = ordered[j]
            j -= 1
        ordered[j + 1] = item
    if descending:
        ordered.reverse()
    return ordered


def sort_array(array, descending=False):
    """Feature 15 block: sort array [my_array] [ascending/descending].

    Works on numbers and text; arrays mixing the two fall back to text order.
    """
    values = list(array)
    try:
        values.sort()
    except TypeError:
        return _sort_by_text(values, bool(descending))
    if descending:
        values.reverse()
    return values


def sort_array_in_place(array, descending=False):
    """Feature 15: sort in place and return the same array."""
    ordered = sort_array(array, descending)
    array[:] = ordered
    return array


# --- comparator factories, handy from blocks -------------------------------

def gt(value):
    return lambda item: item > value


def lt(value):
    return lambda item: item < value


def ge(value):
    return lambda item: item >= value


def le(value):
    return lambda item: item <= value


def eq(value):
    return lambda item: item == value


def between(low, high):
    return lambda item: low <= item <= high


def contains(text):
    return lambda item: str(text) in str(item)


def starts_with(text):
    return lambda item: str(item).startswith(str(text))


def is_even(item):
    return item % 2 == 0


def is_odd(item):
    return item % 2 == 1


def positive(item):
    return item > 0


def negative(item):
    return item < 0


# --- transformation factories ---------------------------------------------

def add(amount):
    return lambda item: item + amount


def subtract(amount):
    return lambda item: item - amount


def multiply(factor):
    return lambda item: item * factor


def divide(factor):
    return lambda item: item / factor


def clamp(low, high):
    def transform(item):
        if item < low:
            return low
        if item > high:
            return high
        return item
    return transform


def map_range(from_low, from_high, to_low, to_high):
    span = from_high - from_low
    if span == 0:
        span = 1
    scale = (to_high - to_low) / span

    def transform(item):
        return to_low + (item - from_low) * scale
    return transform


def filter_array(array, predicate):
    """Feature 16 block: filter array [my_array] where [condition]."""
    out = []
    for item in array:
        if predicate(item):
            out.append(item)
    return out


def map_array(array, transform):
    """Feature 17 block: map array [my_array] with [operation]."""
    out = []
    for item in array:
        out.append(transform(item))
    return out


# ---------------------------------------------------------------------------
# Features 18-20: motors and servos
# ---------------------------------------------------------------------------

FORWARD = 1
BACKWARD = 0


def _pwm_value(speed):
    """Map 0-255 onto the micro:bit's 0-1023 PWM range."""
    if speed < 0:
        speed = 0
    elif speed > 255:
        speed = 255
    return int(speed * 1023 // 255)


class Motor(object):
    """Feature 18: one DC motor on a PWM pin plus an optional direction pin.

    ``Motor(pin13)`` uses PWM only (a motor driver that takes a single speed
    input). ``Motor(pin13, pin14)`` drives IN1/IN2 style H-bridges: PWM on the
    speed pin, logic level on the direction pin.
    """

    def __init__(self, speed_pin, direction_pin=None, invert=False):
        self.speed_pin = speed_pin
        self.direction_pin = direction_pin
        self.invert = invert
        self._speed = 0
        self._forward = True
        self.speed_pin.write_analog(0)
        if direction_pin is not None:
            direction_pin.write_digital(0)

    def set_speed(self, speed):
        """Feature 18 block: set motor speed [0-255]."""
        speed = int(speed)
        if speed < 0:
            speed = 0
        elif speed > 255:
            speed = 255
        self._speed = speed
        self.speed_pin.write_analog(_pwm_value(speed))
        return speed

    def set_direction(self, direction):
        """Feature 18 block: set motor direction [forward/backward]."""
        forward = direction
        if isinstance(direction, str):
            forward = direction.lower() != 'backward'
        forward = bool(forward)
        self._forward = forward
        if self.direction_pin is not None:
            level = 1 if forward else 0
            if self.invert:
                level = 1 - level
            self.direction_pin.write_digital(level)
        return forward

    def drive(self, value):
        """Signed speed: -255 (full reverse) to 255 (full forward)."""
        value = int(value)
        if value < 0:
            self.set_direction(False)
            return self.set_speed(-value)
        self.set_direction(True)
        return self.set_speed(value)

    def forward(self, speed=255):
        self.set_direction(True)
        return self.set_speed(speed)

    def backward(self, speed=255):
        self.set_direction(False)
        return self.set_speed(speed)

    def stop(self):
        self._speed = 0
        self.speed_pin.write_analog(0)
        return 0

    def brake(self):
        self.stop()
        if self.direction_pin is not None:
            self.direction_pin.write_digital(1)
        return 0

    def speed(self):
        return self._speed

    def direction(self):
        return self._forward


class Servo(object):
    """Feature 19: 0-180 degree servo with optional smooth movement."""

    def __init__(self, pin, minimum=500, maximum=2500, travel=180,
                 step_delay=15):
        self.pin = pin
        self.minimum = minimum
        self.maximum = maximum
        self.travel = travel
        self.step_delay = step_delay
        self._angle = 0
        self.pin.set_analog_period(20)
        self._write(0)

    def _pulse(self, angle):
        span = self.maximum - self.minimum
        return self.minimum + span * angle // self.travel

    def _write(self, angle):
        pulse = self._pulse(angle)
        self.pin.write_analog(int(pulse * 1023 // 20000))

    def set_angle(self, angle, smooth=True):
        """Feature 19 block: set servo angle [0-180]."""
        angle = int(angle)
        if angle < 0:
            angle = 0
        elif angle > self.travel:
            angle = self.travel
        if smooth and self.step_delay > 0:
            step = 4 if angle > self._angle else -4
            while self._angle != angle:
                self._angle += step
                if (step > 0 and self._angle > angle) or \
                        (step < 0 and self._angle < angle):
                    self._angle = angle
                self._write(self._angle)
                sleep(self.step_delay)
        else:
            self._angle = angle
            self._write(angle)
        return self._angle

    def angle(self):
        return self._angle

    def center(self):
        return self.set_angle(self.travel // 2)


class Chassis(object):
    """Feature 20: two motors driven together for differential steering."""

    def __init__(self, left, right, invert_left=False, invert_right=False):
        self.left = left
        self.right = right
        self.invert_left = invert_left
        self.invert_right = invert_right

    def move(self, left_speed, right_speed):
        """Feature 20 block: move [left: 200] [right: 180]."""
        left_speed = int(left_speed)
        right_speed = int(right_speed)
        if self.invert_left:
            left_speed = -left_speed
        if self.invert_right:
            right_speed = -right_speed
        self.left.drive(left_speed)
        self.right.drive(right_speed)
        return (left_speed, right_speed)

    def forward(self, speed=255):
        return self.move(speed, speed)

    def backward(self, speed=255):
        return self.move(-speed, -speed)

    def turn_left(self, speed=180):
        return self.move(-speed, speed)

    def turn_right(self, speed=180):
        return self.move(speed, -speed)

    def spin(self, speed=255):
        return self.move(-speed, speed)

    def stop(self):
        self.left.stop()
        self.right.stop()
        return (0, 0)


_left_motor = None
_right_motor = None
_chassis = None


def set_motors(left, right, invert_left=False, invert_right=False):
    """Feature 20 setup: register the two drive motors."""
    global _left_motor, _right_motor, _chassis
    _left_motor = left
    _right_motor = right
    _chassis = Chassis(left, right, invert_left, invert_right)
    return _chassis


def set_motor_pins(left_speed_pin, left_direction_pin=None,
                   right_speed_pin=None, right_direction_pin=None):
    """Convenience: build the motors and chassis from pins."""
    left = Motor(left_speed_pin, left_direction_pin)
    if right_speed_pin is None:
        right = Motor(left_direction_pin) if left_direction_pin else left
    else:
        right = Motor(right_speed_pin, right_direction_pin)
    return set_motors(left, right)


def move(left_speed, right_speed):
    """Feature 20: move both motors, negative values reverse."""
    if _chassis is None:
        raise ValueError('call set_motors() or set_motor_pins() first')
    return _chassis.move(left_speed, right_speed)


def forward(speed=255):
    return move(speed, speed)


def backward(speed=255):
    return move(-speed, -speed)


def turn_left(speed=180):
    return move(-speed, speed)


def turn_right(speed=180):
    return move(speed, -speed)


def stop_motors():
    if _chassis is None:
        raise ValueError('call set_motors() or set_motor_pins() first')
    return _chassis.stop()


# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------

def status():
    """A dict summarising the current configuration (handy when debugging)."""
    return {
        'id': _self_id,
        'started': _started,
        'rssi': _last_rssi,
        'sender_filter': list(_sender_filter),
        'threshold': _signal_threshold,
        'content_filter': _content_filter,
        'handlers': len(_handlers),
        'melodies': len(_melodies),
        'version': __version__,
    }


def reset_all():
    """Restore the library to its just-imported state."""
    global _last_rssi, _last_msg, _last_error, _last_signal
    global _left_motor, _right_motor, _chassis
    clear_filters()
    off_handlers()
    _functions.clear()
    _last_rssi = -100
    _last_msg = None
    _last_error = None
    _last_signal = 0
    _left_motor = None
    _right_motor = None
    _chassis = None
