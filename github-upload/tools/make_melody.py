#!/usr/bin/env python3
"""Convert a WAV file into MB8 audio for ``ultra_expansion``.

MB8 is the tiny 4-bit delta format the MicroPython runtime plays back at the
micro:bit's fixed 7812.5 Hz sample rate. One byte holds two samples, and each
sample is stored as a -8..+7 step from the previous one, so a melody costs
roughly a quarter of the space of 16-bit PCM.

Usage:
    python3 tools/make_melody.py intro.wav --name intro
    python3 tools/make_melody.py intro.wav --name intro --max-seconds 3 --out intro.mb8
"""

import argparse
import sys
import wave

MAGIC = b'MB8\x01'
RATES = (7812, 8000, 11025, 16000, 22050, 4000)
SILENCE = 128


def read_pcm(frames, width):
    """Decode raw PCM frames into signed 16-bit-ish integers."""
    if width == 1:
        return [b - 128 for b in frames]
    samples = []
    if width == 2:
        step = 2
    elif width == 3:
        step = 3
    elif width == 4:
        step = 4
    else:
        raise ValueError('unsupported sample width: %d bytes' % width)
    for i in range(0, len(frames) - step + 1, step):
        chunk = frames[i:i + step]
        if width == 2:
            samples.append(int.from_bytes(chunk, 'little', signed=True))
        elif width == 3:
            samples.append(int.from_bytes(chunk, 'little', signed=True) >> 8)
        else:
            samples.append(int.from_bytes(chunk, 'little', signed=True) >> 16)
    return samples


def load_wav(path):
    """Return ``(mono_samples, sample_rate)`` for a PCM WAV file."""
    with wave.open(path, 'rb') as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    samples = read_pcm(frames, width)
    if channels > 1:
        mono = []
        for i in range(0, len(samples) - channels + 1, channels):
            total = 0
            for channel in range(channels):
                total += samples[i + channel]
            mono.append(total // channels)
        samples = mono
    return samples, rate


def resample(samples, source_rate, target_rate):
    """Linear-interpolation resampler (good enough for 8-bit audio)."""
    if source_rate == target_rate or not samples:
        return list(samples)
    count = int(len(samples) * target_rate / source_rate)
    step = source_rate / target_rate
    out = []
    for i in range(count):
        position = i * step
        index = int(position)
        fraction = position - index
        first = samples[index]
        second = samples[index + 1] if index + 1 < len(samples) else first
        out.append(int(first + (second - first) * fraction))
    return out


def normalize(samples, peak=120, gain=1.0):
    """Scale so the loudest sample sits at ``peak`` out of 127."""
    if not samples:
        return []
    loudest = 0
    for sample in samples:
        value = sample if sample >= 0 else -sample
        if value > loudest:
            loudest = value
    if loudest == 0:
        return [0 for _ in samples]
    scale = (peak / loudest) * gain
    return [int(sample * scale) for sample in samples]


def encode_mb8(samples, rate_code=0):
    """Encode signed samples (-128..127) as MB8 bytes."""
    data = bytearray(MAGIC)
    data.append(rate_code & 0x0F)
    level = 0
    pending = 0
    have_pending = False
    for sample in samples:
        target = sample
        if target > 127:
            target = 127
        elif target < -128:
            target = -128
        delta = target - level
        if delta > 7:
            delta = 7
        elif delta < -8:
            delta = -8
        level += delta
        if level > 127:
            level = 127
        elif level < -128:
            level = -128
        nibble = delta + 8
        if have_pending:
            data.append(pending | (nibble << 4))
            have_pending = False
        else:
            pending = nibble
            have_pending = True
    if have_pending:
        # Pad the final half byte with silence so decoding stays symmetrical.
        data.append(pending)
    return bytes(data)


def encode_pcm(samples, source_rate, target_rate=7812, peak=120, gain=1.0):
    """WAV samples in, MB8 bytes out."""
    rate_code = RATES.index(target_rate) if target_rate in RATES else 0
    if target_rate not in RATES:
        target_rate = RATES[rate_code]
    mono = resample(samples, source_rate, target_rate)
    signed = normalize(mono, peak=peak, gain=gain)
    return encode_mb8(signed, rate_code)


def format_python(name, data, indent='    '):
    """Render ``register_melody('name', ...)`` as copy-pasteable source."""
    lines = ["register_melody('%s', (" % name]
    for start in range(0, len(data), 20):
        chunk = data[start:start + 20]
        escape = ''.join('\\x%02x' % byte for byte in chunk)
        lines.append("%sb'%s'" % (indent, escape))
    lines.append('))')
    return '\n'.join(lines)


def melody_seconds(data):
    return (len(data) - len(MAGIC) - 1) * 2 / 7812.5


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('wav', help='input .wav file (PCM 8/16/24/32-bit)')
    parser.add_argument('--name', default=None, help='melody name for the block')
    parser.add_argument('--rate', type=int, default=7812, choices=RATES,
                        help='target sample rate (7812 matches the hardware)')
    parser.add_argument('--max-seconds', type=float, default=5.0,
                        help='trim to this length (default 5s)')
    parser.add_argument('--gain', type=float, default=1.0,
                        help='extra gain multiplier (default 1.0)')
    parser.add_argument('--peak', type=int, default=120,
                        help='peak sample level 0-127 (default 120)')
    parser.add_argument('--out', default=None, help='write raw .mb8 bytes here')
    parser.add_argument('--module', default=None,
                        help='write a .py melody module instead of stdout')
    args = parser.parse_args(argv)

    samples, rate = load_wav(args.wav)
    source_name = args.name
    if source_name is None:
        base = args.wav.replace('\\', '/').split('/')[-1]
        source_name = base.rsplit('.', 1)[0]
    limit = int(args.max_seconds * rate)
    if len(samples) > limit:
        samples = samples[:limit]
    data = encode_pcm(samples, rate, args.rate, args.peak, args.gain)

    if args.out:
        with open(args.out, 'wb') as handle:
            handle.write(data)
    snippet = format_python(source_name, data)
    if args.module:
        header = ('"""Melody bank for ultra_expansion.\n\n'
                  'Generated by tools/make_melody.py from %s.\n'
                  'Import this after ultra_expansion to register the melodies.\n"""\n\n'
                  'from ultra_expansion import register_melody\n\n'
                  % args.wav)
        with open(args.module, 'w', encoding='utf-8') as handle:
            handle.write(header + snippet + '\n')
    print('melody:   %s' % source_name)
    print('samples:  %d at %d Hz (%.2f s)' % (len(samples), args.rate,
                                              melody_seconds(data)))
    print('payload:  %d bytes MB8 (~%d bytes of source)'
          % (len(data), len(snippet)))
    if not args.module:
        print()
        print(snippet)
    return 0


if __name__ == '__main__':
    sys.exit(main())
