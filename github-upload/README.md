# Ultra Expansion Pack for the BBC micro:bit

Twenty upgrades for the micro:bit in one package: filtered radio, numeric
command codes, serialised function calls, MP3-derived melody playback, dynamic
arrays and objects, and proper PWM motor/servo control.

Three runtimes — blocks, JavaScript and MicroPython — speak **the same binary
radio protocol**, so boards built with any of them can talk to each other:

| Front-end | Files | Use it when |
| --- | --- | --- |
| MakeCode block expansion | [`main.ts`](main.ts), [`ultra.ts`](ultra.ts), [`pxt.json`](pxt.json) | You want the twenty blocks in [MakeCode](https://makecode.microbit.org) |
| JavaScript runtime | [`js/ultra.js`](js/ultra.js) | You want plain ES5 JavaScript that runs under Node, or a reference to port from |
| MicroPython port | [`micropython/ultra_expansion.py`](micropython/ultra_expansion.py), [`micropython/melodies.py`](micropython/melodies.py) | You prefer Python in the [micro:bit Python editor](https://python.microbit.org) |
| Web converter | [`docs/index.html`](docs/index.html) | You want to turn an MP3 into melody data (GitHub Pages ready) |

---

## Contents

```
main.ts / ultra.ts / pxt.json    MakeCode block expansion (JavaScript/TypeScript)
js/ultra.js                      plain JavaScript runtime, same 20 features (Node)
js/examples/                     JavaScript programs that call the extension's API
micropython/ultra_expansion.py   optional MicroPython port
micropython/melodies.py          generated MB8 melody bank
docs/                            MP3 -> MB8 converter for GitHub Pages
tools/make_melody.py             WAV -> MB8 encoder (command line)
tools/make_demo_melodies.py      regenerates micropython/melodies.py
examples/                        four MicroPython programs
tests/                           Node and CPython test suites
```

---

## Quick start: the block expansion

1. Push this repository to GitHub.
2. In MakeCode open **Extensions → … → Import URL** and enter your repository
   URL (`https://github.com/<you>/<repo>`).
3. The **Ultra** toolbox appears with all twenty blocks.

Blocks default to radio group 1, sender ID 1 and motor pins P13/P14 (left) /
P15/P16 (right); change them with `start ultra radio on group` and
`use motors …`. The extension source is TypeScript because that is the
language MakeCode compiles, but every block is ordinary JavaScript logic in
[`ultra.ts`](ultra.ts), and the same functions are callable from the MakeCode
**JavaScript** tab (`ultra.playMelody("startup")`, `ultra.move(200, 180)`, …).

---

## Using JavaScript instead of blocks

In MakeCode the **JavaScript** tab compiles the same TypeScript the blocks do,
so with the extension installed every block has a JavaScript equivalent and you
can skip the toolbox entirely:

```js
ultra.startRadio(1);
ultra.setIdBlock(2);

ultra.defineCommandBlock(101, "turn left");
ultra.onSenderBlock(1, function () {
    basic.showString(ultra.lastTextBlock());
});
ultra.onCommandBlock(101, function () {
    ultra.moveBlock(0, 200);
});

ultra.registerMelody("startup", "c5 e5 g5 c6");
ultra.playMelody("startup");
```

[`js/ultra.js`](js/ultra.js) is the same twenty features as a standalone ES5
runtime with no compiler and no blocks. It runs under Node (that is what
`tests/test_ultra_js.js` drives) and serves as the reference implementation for
other ports. It is not a MakeCode project file: pxt compiles `.ts` sources
only, so a `.js` file added to a project is ignored (`Cannot find name 'ultra'`).
On the micro:bit, the JavaScript API above is the supported path.

---

## Quick start: MicroPython (optional port)

1. Open <https://python.microbit.org> and create a project.
2. Paste in [`micropython/ultra_expansion.py`](micropython/ultra_expansion.py)
   as a new file (the editor's **Project → Add file** button), or flash it with
   `uflash ultra_expansion.py`.
3. Paste [`micropython/melodies.py`](micropython/melodies.py) too if you want
   the built-in tunes.
4. Write your program:

```python
from microbit import *
import ultra_expansion as ultra
import melodies                     # optional: startup, coin, alarm, robot

ultra.start(group=1)                # same group on every board
ultra.set_id(2)                     # this board's sender ID

ultra.define_command(101, "turn left")
ultra.define_command(102, "turn right")

@ultra.on_sender(1)                 # feature 2: only listen to board 1
def from_base(msg):
    display.scroll(msg.text)

@ultra.on_signal_above(-70)         # feature 4: strong packets only
def strong(msg):
    display.show(Image.YES)

@ultra.on_command(101)              # feature 6/8: numeric command codes
def left(msg):
    display.show(Image.ARROW_W)

ultra.play_melody("startup")        # feature 1
ultra.run()                         # poll forever
```

`ultra.run()` is just a `while True: ultra.poll(); sleep(20)` loop. Use
`ultra.poll()` yourself if you already have a main loop.

---

## Feature reference

Every feature has a JavaScript function and a matching block. The names below
are the standalone [`js/ultra.js`](js/ultra.js) API; inside the extension the
same operations are the block functions (`onSenderBlock`, `moveBlock`, …). The
MicroPython port exposes them in `snake_case` (see the port section).

| # | Feature | JavaScript (`ultra.*`) | MakeCode block |
| --- | --- | --- | --- |
| 1 | Melody playback | `registerMelody(name, notes)`, `playMelody(name)` | `play melody [name]` |
| 2 | Sender-ID filtering | `setSenderFilter([1, 4])`, `onSender(1, fn)` | `on radio received from sender ID [1]` |
| 3 | RSSI signal strength | `signalStrength()`, `lastRssi()` | `radio signal strength (dBm)` |
| 4 | Signal threshold | `setSignalThreshold(-70)`, `onSignalAbove(-70, fn)` | `on radio received if signal strength > [-70] dBm` |
| 5 | Content filtering | `setContentFilter("LED")`, `onContent("LED", fn)` | `receive signal containing [LED]` |
| 6 | Command codes | `sendCommand(101)`, `defineCommand(101, "turn left")` | `send command code [101]` |
| 7 | Function serialisation | `sendCall("drive", [200, -200])`, `registerFunction(...)` | `send serialized function [drive] arg [0] …` |
| 8 | Code decoder | `decodeCommand(code)`, `lastSignal()` | `decode received code [last signal code]` |
| 9 | Array unpacking | `unpack(arr, 3)`, `setVariables("x, y, z", arr)` | `set variables [x, y, z] from array [arr]` |
| 10 | Variables from keys | `variablesFromKeys(arr)` | `create variables from array keys [arr]` |
| 11 | Array → object | `arrayToObject(arr, "x, y, z")` | `array [arr] to object [x, y, z]` |
| 12 | Variable reset | `resetVariable("x")` | `reset variable [x]` |
| 13 | Array reset | `resetArray(arr)` | `reset array [arr]` |
| 14 | Bulk reset | `clearVariables()` | `clear all variables` |
| 15 | Sorting | `sortArray(arr, true)` | `sort array [arr] [descending]` |
| 16 | Filtering | `filterArray(arr, greaterThan(5))` | `filter array [arr] where value [>] [5]` |
| 17 | Mapping | `mapArray(arr, multiplyBy(2))` | `map array [arr] [multiply] [2]` |
| 18 | Motor control | `new Motor(13, 14).setSpeed(200)` | `set motor [P13] speed [200]` |
| 19 | Servo control | `new Servo(1).setAngle(90)` | `set servo [P1] angle [90]°` |
| 20 | Dual motors | `configureMotorPins(...)`, `move(200, 180)` | `move left motor [200] right motor [180]` |

---

## Feature notes

Code samples here use the MicroPython port's `snake_case` names; the
JavaScript API is identical in `camelCase` (`set_sender_filter` →
`setSenderFilter`, `play_melody` → `playMelody`).

### 1. MP3 melody upload and playback

The converter at [`docs/index.html`](docs/index.html) decodes an MP3 (or WAV,
OGG, M4A) in your browser, mixes it to mono, resamples it to the micro:bit's
7812.5 Hz audio rate and encodes it as **MB8**: two 4-bit delta samples per
byte, with `128` as silence.

Output looks like this and is pasted straight into the project:

```python
register_melody('my_tune', (
    b'\x4d\x42\x38\x01\x00...'
    b'...'
))
```

`play_melody("my_tune")` decodes and streams the frames into
`audio.play(...)`, so playback never needs the whole waveform in RAM as 16-bit
samples. Sizes to keep in mind:

| Clip length | MB8 data | Pasted source |
| --- | --- | --- |
| 1 s | ~3.9 KB | ~15 KB |
| 4 s | ~15.6 KB | ~62 KB |

That is why the converter defaults to a 4 second cap. For longer clips keep the
data in a `.py` file flashed to the board rather than pasted in the editor.

micro:bit **v1** has no `audio` module; the library automatically falls back to
`music.pitch()` with a buzzer approximation, so the same program still runs.

In JavaScript, `registerMelody(name, notes)` stores MakeCode note strings and
plays them through `music.playMelody` — the full-quality route. Converted MB8
data can also be registered with `registerMelodyData(name, bytes)`, but
MakeCode JavaScript cannot stream PCM to the DAC, so it is rendered through
`pins.analogPitch` as a buzzer approximation. The MicroPython port is the one
that plays the real 8-bit audio.

The command line equivalent is:

```bash
python3 tools/make_melody.py intro.mp3.wav --name intro --max-seconds 4
```

(`wave` only reads WAV, hence the converter for MP3.)

### 2–5. Radio filtering

`start()` enables the radio with `group`, `channel`, `power` and `length=32`.
Every packet is decoded, checksum-verified, then filtered in this order:

1. **sender filter** — `set_sender_filter([...])` or per-handler `on_sender`
2. **signal threshold** — packets weaker than `set_signal_threshold(dbm)` vanish
3. **content filter** — `set_content_filter(text)` keeps packets whose text
   contains the pattern (`on_content` is the per-handler version)

RSSI comes from `radio.receive_full()` and is exposed as `signal_strength()`
dBm, typically −100 (weak) to −28 (strong on v2; v1 boards top out near −42).
MakeCode's `radio.receivedSignalStrength()` uses the same scale.

### 6–8. Command codes and serialised calls

Instead of sending `"turn left"` (9 bytes plus framing) send `101` (3 bytes).
Codes are defined in a table and decoded on arrival:

```python
ultra.define_command(101, "turn left")
ultra.send_command(101, to=4)
...
print(ultra.decode_command(ultra.last_signal()))   # turn left
```

Function serialisation packs a name and up to 24 bytes of arguments as
`name|arg|arg` with escaping:

```python
ultra.register_function("drive", lambda left, right: ultra.move(left, right))
ultra.send_function("drive", 200, -200, to=4)
# on the receiver the lambda is called with 200 and -200
```

Arguments are re-typed automatically: `12` → int, `2.5` → float, `True` →
bool, everything else stays text.

### 9–11. Arrays, variables and objects

```python
x, y, z = ultra.unpack(readings, 3)            # real local variables
ultra.unpack_into(["x", "y", "z"], readings)   # Ultra variable store
ultra.make_variables({"speed": 120})           # variables from keys
player = ultra.array_to_object([100, 3, "sam"], ["score", "lives", "name"])
player.score                                   # 100
player["lives"]                                # 3
```

> **Where do dynamic variables live?** Both front-ends keep them in a store
> owned by the library — MicroPython cannot write into the calling module's
> globals. Read them back as `ultra.x` (MicroPython) or with the
> `variable [x]` block (MakeCode). `unpack()` is the right tool when you want
> ordinary local variables.

`array_to_object` also accepts `[["x", 1], ["y", 2]]` pairs, and
`object` supports attribute access, `["key"]`, `in`, `keys()`, `items()` and
`to_dict()`.

### 12–14. Resets

`reset_var("x")` writes `0` for numbers, `""` for text, `[]` for lists and `{}`
for dicts. `reset_array(arr)` empties a list **in place** so other references
see the change. `clear_variables()` removes every plain data variable while
leaving functions, classes, imports, `UPPERCASE` constants and names starting
with `_` alone — the library keeps working.

### 15–17. Sorting, filtering, mapping

```python
ultra.sort_array([3, 1, 2])                      # [1, 2, 3]
ultra.sort_array(["b", "a"], descending=True)    # ['b', 'a']
ultra.filter_array(scores, ultra.gt(50))         # keep > 50
ultra.filter_array(names, ultra.contains("an"))
ultra.map_array(values, ultra.multiply(2))
ultra.map_array(values, ultra.map_range(0, 1023, 0, 255))
```

Ready-made predicates: `gt`, `lt`, `ge`, `le`, `eq`, `between`, `contains`,
`starts_with`, `is_even`, `is_odd`, `positive`, `negative`. Ready-made
transforms: `add`, `subtract`, `multiply`, `divide`, `clamp`, `map_range`.
Filtering and mapping return new lists; the original is untouched.

### 18–20. Motors and servos

```python
left  = ultra.Motor(pin13, pin14)          # PWM pin, direction pin
right = ultra.Motor(pin15, pin16)

ultra.set_motors(left, right)
ultra.move(200, 180)                       # both forward
ultra.turn_left(150)                       # left reverses, right forward
ultra.stop_motors()

servo = ultra.Servo(pin1)                  # 500-2500 us, 0-180 degrees
servo.set_angle(90)                        # smooth, 4 degrees per 15 ms
servo.set_angle(0, smooth=False)           # instant
```

`Motor.drive(value)` takes −255…255 (negative reverses), `set_speed(0…255)`
keeps the current direction, `set_direction(True/False)` flips the direction
pin. `Servo` uses a 20 ms period and maps angle → 500–2500 µs.

Suggested wiring (L298N / DRV8833 style drivers):

| micro:bit | Driver | Note |
| --- | --- | --- |
| P13 | ENA / AIN1 (PWM) | left speed |
| P14 | IN1 / AIN2 | left direction |
| P15 | ENB / BIN1 (PWM) | right speed |
| P16 | IN2 / BIN2 | right direction |
| 3V | logic VCC | |
| GND | GND | common ground with the motor supply |

> Power servos and motors from their own supply, never from the micro:bit's 3V
> pin. Always connect the grounds together, and add a capacitor across the
> motor supply if the board resets when the motors start.

---

## Radio protocol

Both front-ends send this frame (10 bytes of overhead, ≤ 24 bytes of payload,
comfortably inside the 32-byte radio packet):

```
0xE7 | version<<4 | kind | src | dst | seq | len | payload ... | XOR checksum
```

| Field | Meaning |
| --- | --- |
| `version` | 1 |
| `kind` | 0 text, 1 command code, 2 serialised call, 3 raw bytes |
| `src` / `dst` | sender ID / destination ID, 255 = broadcast |
| `seq` | rolling 0–255, useful for spotting dropped packets |
| `len` | payload length, max 24 |
| checksum | XOR of every preceding byte |

`ultra.parse_packet(bytes)` and `ultra.pack(kind, payload, to)` are public, so
you can build your own packets. Anything that fails the magic byte, version or
checksum check is silently dropped — a noisy channel cannot crash the program.

---

## Web converter (GitHub Pages)

`docs/` is a complete static site:

1. Push the repository to GitHub.
2. **Settings → Pages → Source: Deploy from a branch → `main` / `/docs`**.
3. Open `https://<you>.github.io/<repo>/`.

Drop an MP3 in, choose a name and length, press **Convert**. You can play the
8-bit preview, copy the code or download it as `melodies.py`. Everything runs
locally with the Web Audio API; nothing is uploaded.

---

## Regenerating the melody bank

```bash
python3 tools/make_demo_melodies.py     # rewrites micropython/melodies.py
python3 tools/make_melody.py song.wav --name song --out song.mb8
```

`make_melody.py` accepts 8/16/24/32-bit PCM WAV, mixes stereo to mono,
resamples and prints a `register_melody()` snippet (or writes a module with
`--module`).

---

## Compiling the extension with pxt

The extension is checked against the real MakeCode compiler with
[`mkc`](https://github.com/microsoft/pxt-mkc):

```bash
npm install -g makecode            # the CLI; provides `mkc`
mkdir ultra-build && cd ultra-build
mkc init microbit                  # downloads the editor + target packages
```

Then point the project at this folder — in `pxt.json` add
`"ultra-expansion": "1.0.0"` to `dependencies`, and in `mkc.json`:

```json
{ "targetWebsite": "https://makecode.microbit.org/beta",
  "links": { "ultra-expansion": "../path/to/this/folder" } }
```

```bash
mkc install
mkc build -j                       # fast JavaScript/type-check pass
mkc build                          # full ARM link -> built/binary.hex
```

Last verified build (makecode CLI 1.3.6, micro:bit target 9.0.12):

| Program | V1 app image | V1 room left | Result |
| --- | --- | --- | --- |
| Blank project (no extension) | 122,032 B | 25,424 B | OK |
| Robot: radio filters + commands + calls + motors + servo + melodies | 143,328 B | 4,128 B | OK, `.hex` produced |
| A program calling all 41 blocks at once | 153,680 B | −6,224 B | too big for V1 |

The V1 app region is 144 KB (0x18000–0x3c000). The all-blocks program
exceeded that limit; its V2 build was not separately verified. If a V1
project reports `program too big`, try removing melody playback or other
features the project does not need.

---

## Tests

Both runtimes are tested without hardware.

JavaScript, with fake `radio`, `pins`, `music` and `control` APIs:

```bash
node tests/test_ultra_js.js
```

The MicroPython port, under CPython with fake `microbit`, `radio` and `audio`
modules:

```bash
python3 -m unittest discover -s tests -v
```

The suites cover packet packing/checksums, every filter, command codes, call
serialisation, resets, sorting/filtering/mapping, MB8 encode/decode symmetry,
frame streaming, PWM and servo maths, and the differential chassis.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Nothing received | Different `group`/`channel`, or `ultra.start()` never called |
| All packets ignored | `set_sender_filter()` still active, or the signal threshold is too high |
| Garbled text | Another program is sending plain `radio.send()` strings; Ultra expects framed packets |
| Melody silent on v1 | No `audio` module; playback falls back to the buzzer approximation |
| `MemoryError` on v2 | Melody too long — trim it to 3–4 seconds |
| Servo jitters or board resets | Servo powered from 3V, or no common ground |
| Motor spins the wrong way | Swap the two motor wires or use `invert=True` |
| `unknown (code)` | That code was never registered with `define_command()` |

---

## License

MIT — see [LICENSE](LICENSE).
