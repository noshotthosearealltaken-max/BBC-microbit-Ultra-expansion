/* Ultra Melody Converter - runs entirely in the browser, no build step.
 *
 * Encodes audio as MB8, the nibble-delta format used by
 * micropython/ultra_expansion.py and tools/make_melody.py:
 *
 *   'M' 'B' '8' 0x01 | rate code | 2 samples per byte (low nibble first)
 *
 * Every sample is a -8..+7 step from the previous one, with unsigned
 * 8-bit output where 128 is silence.
 */
(function () {
  'use strict';

  var RATES = [7812, 8000, 11025, 16000, 22050, 4000];
  var MAGIC = [0x4d, 0x42, 0x38, 0x01];
  var BYTES_PER_LINE = 20;

  var els = {
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    fileName: document.getElementById('fileName'),
    name: document.getElementById('melodyName'),
    maxSeconds: document.getElementById('maxSeconds'),
    sampleRate: document.getElementById('sampleRate'),
    gain: document.getElementById('gain'),
    gainValue: document.getElementById('gainValue'),
    style: document.getElementById('outputStyle'),
    convert: document.getElementById('convertBtn'),
    play: document.getElementById('playBtn'),
    stop: document.getElementById('stopBtn'),
    copy: document.getElementById('copyBtn'),
    download: document.getElementById('downloadBtn'),
    status: document.getElementById('status'),
    stats: document.getElementById('stats'),
    statSource: document.getElementById('statSource'),
    statLength: document.getElementById('statLength'),
    statBytes: document.getElementById('statBytes'),
    statSourceSize: document.getElementById('statSourceSize'),
    code: document.getElementById('code').firstElementChild
  };

  var audioContext = null;
  var sourceFile = null;
  var sourceBuffer = null;
  var sourceName = 'my_tune';
  var mb8Bytes = null;
  var previewBuffer = null;
  var previewNode = null;
  var generatedCode = '';

  function context() {
    if (!audioContext) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      audioContext = new Ctor();
    }
    return audioContext;
  }

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function bytesToKb(count) {
    return count < 1024 ? count + ' B' : (count / 1024).toFixed(1) + ' KB';
  }

  // ---------------------------------------------------------------
  // audio -> samples
  // ---------------------------------------------------------------

  function mixToMono(buffer) {
    var channels = buffer.numberOfChannels;
    var length = buffer.length;
    var mono = new Float32Array(length);
    for (var channel = 0; channel < channels; channel++) {
      var data = buffer.getChannelData(channel);
      for (var i = 0; i < length; i++) mono[i] += data[i];
    }
    if (channels > 1) {
      for (var j = 0; j < length; j++) mono[j] /= channels;
    }
    return mono;
  }

  function resample(input, sourceRate, targetRate, maxSamples) {
    var length = Math.floor(input.length * targetRate / sourceRate);
    if (maxSamples && length > maxSamples) length = maxSamples;
    var step = sourceRate / targetRate;
    var out = new Float32Array(length);
    for (var i = 0; i < length; i++) {
      var position = i * step;
      var index = Math.floor(position);
      var fraction = position - index;
      var first = input[index] || 0;
      var second = index + 1 < input.length ? input[index + 1] : first;
      out[i] = first + (second - first) * fraction;
    }
    return out;
  }

  function normalize(samples, gain, peak) {
    var loudest = 0;
    for (var i = 0; i < samples.length; i++) {
      var value = Math.abs(samples[i]);
      if (value > loudest) loudest = value;
    }
    var scale = loudest > 0 ? (peak / loudest) * gain : 0;
    var out = new Int16Array(samples.length);
    for (var j = 0; j < samples.length; j++) {
      var scaled = Math.round(samples[j] * scale);
      if (scaled > 127) scaled = 127;
      if (scaled < -128) scaled = -128;
      out[j] = scaled;
    }
    return out;
  }

  // ---------------------------------------------------------------
  // MB8 encoder (must mirror tools/make_melody.py)
  // ---------------------------------------------------------------

  function encodeMb8(samples, rateCode) {
    var output = [];
    for (var m = 0; m < MAGIC.length; m++) output.push(MAGIC[m]);
    output.push(rateCode & 0x0f);
    var level = 0;
    var pending = 0;
    var havePending = false;
    for (var i = 0; i < samples.length; i++) {
      var target = samples[i];
      var delta = target - level;
      if (delta > 7) delta = 7;
      if (delta < -8) delta = -8;
      level += delta;
      if (level > 127) level = 127;
      if (level < -128) level = -128;
      var nibble = delta + 8;
      if (havePending) {
        output.push(pending | (nibble << 4));
        havePending = false;
      } else {
        pending = nibble;
        havePending = true;
      }
    }
    if (havePending) output.push(pending);
    return new Uint8Array(output);
  }

  function decodeMb8(data) {
    var level = 128;
    var samples = [];
    for (var i = 5; i < data.length; i++) {
      var byte = data[i];
      var low = byte & 0x0f;
      level += low - 8;
      level = Math.max(0, Math.min(255, level));
      samples.push(level);
      var high = (byte >> 4) & 0x0f;
      level += high - 8;
      level = Math.max(0, Math.min(255, level));
      samples.push(level);
    }
    return samples;
  }

  // ---------------------------------------------------------------
  // Python source generation
  // ---------------------------------------------------------------

  function escapeBytes(data) {
    var lines = [];
    for (var start = 0; start < data.length; start += BYTES_PER_LINE) {
      var chunk = '';
      for (var i = start; i < Math.min(start + BYTES_PER_LINE, data.length); i++) {
        var hex = data[i].toString(16);
        if (hex.length < 2) hex = '0' + hex;
        chunk += '\\x' + hex;
      }
      lines.push("    b'" + chunk + "'");
    }
    return lines.join('\n');
  }

  function sanitizeName(text) {
    var cleaned = (text || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
    if (!cleaned) cleaned = 'my_tune';
    if (/^[0-9]/.test(cleaned)) cleaned = 'm_' + cleaned;
    return cleaned;
  }

  function makeCode(name, data, asModule) {
    var literal = "register_melody('" + name + "', (\n" + escapeBytes(data) + "\n))";
    if (!asModule) return literal;
    return '"""Melody bank for the Ultra Expansion Pack.\n\n' +
      'Generated with the Ultra Melody Converter (docs/index.html).\n' +
      'Import this after ultra_expansion to register the melodies.\n"""\n\n' +
      'from ultra_expansion import register_melody\n\n' + literal + '\n';
  }

  // ---------------------------------------------------------------
  // conversion pipeline
  // ---------------------------------------------------------------

  function convert() {
    if (!sourceBuffer) return;
    var rate = parseInt(els.sampleRate.value, 10);
    if (RATES.indexOf(rate) < 0) rate = 7812;
    var rateCode = RATES.indexOf(rate);
    var gain = parseFloat(els.gain.value) || 1;
    var maxSeconds = Math.max(0.2, parseFloat(els.maxSeconds.value) || 4);
    var mono = mixToMono(sourceBuffer);
    var limited = resample(mono, sourceBuffer.sampleRate, rate,
      Math.floor(maxSeconds * rate));
    var samples = normalize(limited, gain, 120);
    var data = encodeMb8(samples, rateCode);
    var name = sanitizeName(els.name.value);
    var asModule = els.style.value === 'module';

    mb8Bytes = data;
    sourceName = name;
    generatedCode = makeCode(name, data, asModule);

    els.code.textContent = generatedCode;
    els.statSource.textContent = sourceFile ? sourceFile.name : 'audio';
    els.statLength.textContent = (limited.length / rate).toFixed(2) + ' s';
    els.statBytes.textContent = bytesToKb(data.length);
    els.statSourceSize.textContent = bytesToKb(generatedCode.length);
    els.stats.classList.remove('hidden');

    els.play.disabled = false;
    els.copy.disabled = false;
    els.download.disabled = false;

    previewBuffer = buildPreview(data, rate);
    setStatus('Converted ' + name + ' at ' + rate + ' Hz - ' + data.length +
      ' bytes of MB8 data.', 'ok');
  }

  function buildPreview(data, rate) {
    var samples = decodeMb8(data);
    var buffer = context().createBuffer(1, samples.length, rate);
    var channel = buffer.getChannelData(0);
    for (var i = 0; i < samples.length; i++) {
      channel[i] = (samples[i] - 128) / 128;
    }
    return buffer;
  }

  function playPreview() {
    if (!previewBuffer) return;
    stopPreview();
    var ctx = context();
    if (ctx.state === 'suspended') ctx.resume();
    previewNode = ctx.createBufferSource();
    previewNode.buffer = previewBuffer;
    previewNode.connect(ctx.destination);
    previewNode.onended = function () {
      previewNode = null;
      els.stop.disabled = true;
    };
    previewNode.start(0);
    els.stop.disabled = false;
    setStatus('Playing the 8-bit version at ' + Math.round(previewBuffer.sampleRate) + ' Hz.', 'ok');
  }

  function stopPreview() {
    if (previewNode) {
      try { previewNode.stop(); } catch (error) { /* already stopped */ }
      previewNode = null;
    }
    els.stop.disabled = true;
  }

  // ---------------------------------------------------------------
  // file handling
  // ---------------------------------------------------------------

  function handleFile(file) {
    if (!file) return;
    sourceFile = file;
    els.fileName.textContent = file.name + ' (' + bytesToKb(file.size) + ')';
    setStatus('Decoding ' + file.name + '...');
    els.convert.disabled = true;
    var reader = new FileReader();
    reader.onerror = function () {
      setStatus('Could not read that file.', 'error');
    };
    reader.onload = function () {
      var ctx = context();
      var bytes = reader.result;
      var onDecoded = function (buffer) {
        sourceBuffer = buffer;
        els.convert.disabled = false;
        if (!els.name.value || els.name.value === 'my_tune') {
          els.name.value = sanitizeName(file.name.replace(/\.[^.]+$/, ''));
        }
        convert();
      };
      var onError = function () {
        setStatus('That file could not be decoded. Try MP3, WAV, OGG or M4A.', 'error');
      };
      try {
        var maybePromise = ctx.decodeAudioData(bytes, onDecoded, onError);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(onDecoded).catch(onError);
        }
      } catch (error) {
        onError();
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ---------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------

  els.dropzone.addEventListener('click', function () { els.fileInput.click(); });
  els.dropzone.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener('change', function () {
    handleFile(els.fileInput.files[0]);
  });

  ['dragenter', 'dragover'].forEach(function (name) {
    els.dropzone.addEventListener(name, function (event) {
      event.preventDefault();
      els.dropzone.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (name) {
    els.dropzone.addEventListener(name, function (event) {
      event.preventDefault();
      els.dropzone.classList.remove('dragging');
    });
  });
  els.dropzone.addEventListener('drop', function (event) {
    var files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) handleFile(files[0]);
  });

  els.convert.addEventListener('click', convert);
  els.play.addEventListener('click', playPreview);
  els.stop.addEventListener('click', stopPreview);
  els.gain.addEventListener('input', function () {
    els.gainValue.textContent = parseFloat(els.gain.value).toFixed(1) + '\u00d7';
  });
  els.style.addEventListener('change', function () {
    if (mb8Bytes) convert();
  });
  [els.name, els.maxSeconds, els.sampleRate].forEach(function (element) {
    element.addEventListener('change', function () {
      if (mb8Bytes) convert();
    });
  });

  els.copy.addEventListener('click', function () {
    if (!generatedCode) return;
    var done = function () { setStatus('Copied to the clipboard.', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(generatedCode).then(done, function () {
        setStatus('Copy failed - select the code and copy it manually.', 'error');
      });
    } else {
      var area = document.createElement('textarea');
      area.value = generatedCode;
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
        done();
      } catch (error) {
        setStatus('Copy failed - select the code and copy it manually.', 'error');
      }
      document.body.removeChild(area);
    }
  });

  els.download.addEventListener('click', function () {
    if (!generatedCode) return;
    var blob = new Blob([generatedCode], { type: 'text/x-python' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = els.style.value === 'module'
      ? 'melodies.py'
      : sourceName + '_melody.py';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
})();
