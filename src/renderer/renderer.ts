/**
 * Audio worker running in a hidden BrowserWindow.
 * Handles microphone recording (MediaRecorder or raw PCM) and PCM streaming playback (Web Audio API).
 * No UI rendering – all visual elements have been removed.
 */

/// <reference path="../shared/types.ts" />

import toggleOnUrl from "../assets/toggle_on.wav?url";
import toggleOffUrl from "../assets/toggle_off.wav?url";
import { downsample } from "../shared/audio-utils.js";

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let audioContext: AudioContext | null = null;

// ── PCM recording state ──────────────────────────────────────────────
let pcmStream: MediaStream | null = null;
let pcmSourceNode: MediaStreamAudioSourceNode | null = null;
let pcmProcessorNode: ScriptProcessorNode | null = null;
let pcmChunks: Float32Array[] = [];
let pcmRecording = false;

/** Target sample rate for Whisper */
const WHISPER_SAMPLE_RATE = 16000;

// ── Device resolution ─────────────────────────────────────────────────
// Chromium's own "default" device (used when no deviceId is given to getUserMedia /
// AudioContext.setSinkId) doesn't reliably track the system/PipeWire default — that's what
// `pi-voice calibrate` (services/calibrate.ts) exists to work around. Config stores the human's
// choice as a device *label*, not a deviceId (Chromium's deviceIds aren't guaranteed stable
// across app launches), so it has to be re-resolved against a fresh enumerateDevices() call
// every time.

async function resolveDeviceId(
  label: string | undefined,
  kind: "audioinput" | "audiooutput",
): Promise<string | undefined> {
  if (!label) return undefined;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const match = devices.find((d) => d.kind === kind && d.label === label);
  if (!match) {
    console.warn(`Calibrated ${kind} device "${label}" not found, falling back to default`);
    return undefined;
  }
  return match.deviceId;
}

function playSoundEffect(url: string) {
  const ctx = audioContext ?? new AudioContext();
  if (!audioContext) audioContext = ctx;

  fetch(url)
    .then((res) => res.arrayBuffer())
    .then((buf) => ctx.decodeAudioData(buf))
    .then((decoded) => {
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      const gain = ctx.createGain();
      gain.gain.value = 2.0;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start();
    })
    .catch((err) => {
      console.error("Failed to play sound effect:", err);
    });
}

// ── WebM recording (for cloud providers) ─────────────────────────────

function startWebmRecording(stream: MediaStream) {
  audioChunks = [];

  mediaRecorder = new MediaRecorder(stream, {
    mimeType: "audio/webm;codecs=opus",
  });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      audioChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((track) => track.stop());

    if (audioChunks.length === 0) {
      window.piVoice.sendRecordingError("No audio data captured");
      return;
    }

    const blob = new Blob(audioChunks, { type: "audio/webm" });
    const arrayBuffer = await blob.arrayBuffer();
    window.piVoice.sendRecordingData(arrayBuffer);
  };

  mediaRecorder.start(100);
}

function stopWebmRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

// ── Raw PCM recording (for local Whisper) ────────────────────────────

function startPcmRecording(stream: MediaStream) {
  const ctx = audioContext ?? new AudioContext();
  if (!audioContext) audioContext = ctx;

  pcmStream = stream;
  pcmChunks = [];
  pcmRecording = true;

  pcmSourceNode = ctx.createMediaStreamSource(stream);

  // Buffer size 4096 is a good balance between latency and performance
  pcmProcessorNode = ctx.createScriptProcessor(4096, 1, 1);
  pcmProcessorNode.onaudioprocess = (event) => {
    if (!pcmRecording) return;
    // Copy the channel data (it gets reused by the browser)
    const input = event.inputBuffer.getChannelData(0);
    pcmChunks.push(new Float32Array(input));
  };

  pcmSourceNode.connect(pcmProcessorNode);
  // ScriptProcessorNode requires connection to destination to fire events
  pcmProcessorNode.connect(ctx.destination);
}

function stopPcmRecording() {
  pcmRecording = false;

  pcmProcessorNode?.disconnect();
  pcmSourceNode?.disconnect();
  pcmStream?.getTracks().forEach((track) => track.stop());

  if (pcmChunks.length === 0) {
    window.piVoice.sendRecordingError("No audio data captured");
    pcmProcessorNode = null;
    pcmSourceNode = null;
    pcmStream = null;
    return;
  }

  // Concatenate all chunks
  const totalLength = pcmChunks.reduce((sum, c) => sum + c.length, 0);
  const fullBuffer = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of pcmChunks) {
    fullBuffer.set(chunk, offset);
    offset += chunk.length;
  }

  // Downsample from AudioContext.sampleRate (typically 48kHz) to 16kHz
  const sourceSampleRate = audioContext?.sampleRate ?? 48000;
  const resampled = downsample(fullBuffer, sourceSampleRate, WHISPER_SAMPLE_RATE);

  // Send as ArrayBuffer (Float32)
  window.piVoice.sendRecordingData(resampled.buffer as ArrayBuffer);

  pcmChunks = [];
  pcmProcessorNode = null;
  pcmSourceNode = null;
  pcmStream = null;
}

// ── Recording control from main ──────────────────────────────────────

let currentRecordingFormat: "webm" | "pcm" = "webm";

window.piVoice.onStartRecording(async (format, inputDeviceLabel) => {
  playSoundEffect(toggleOnUrl);
  currentRecordingFormat = format;

  try {
    const deviceId = await resolveDeviceId(inputDeviceLabel, "audioinput");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });

    if (format === "pcm") {
      startPcmRecording(stream);
    } else {
      startWebmRecording(stream);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    window.piVoice.sendRecordingError(`Microphone access failed: ${msg}`);
  }
});

window.piVoice.onStopRecording(() => {
  playSoundEffect(toggleOffUrl);

  if (currentRecordingFormat === "pcm") {
    stopPcmRecording();
  } else {
    stopWebmRecording();
  }
});

// ── Streaming PCM playback ──────────────────────────────────────────
let streamSampleRate = 24000;
let streamChannels = 1;
let streamBitsPerSample = 16;
let streamNextPlayTime = 0;
let streamActiveSources = 0;
let streamEnded = false;

function stopStreamPlayback() {
  streamActiveSources = 0;
  streamEnded = false;
  streamNextPlayTime = 0;
}

window.piVoice.onPlayAudioStreamStart((meta) => {
  (async () => {
    try {
      if (!audioContext) {
        audioContext = new AudioContext();
      }

      const deviceId = await resolveDeviceId(meta.outputDeviceLabel, "audiooutput");
      if (deviceId && "setSinkId" in audioContext) {
        await (audioContext as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(
          deviceId,
        );
      }

      // Reset streaming state
      stopStreamPlayback();
      streamSampleRate = meta.sampleRate;
      streamChannels = meta.channels;
      streamBitsPerSample = meta.bitsPerSample;
      streamNextPlayTime = 0;
      streamEnded = false;
    } catch (err) {
      console.error("Stream start error:", err);
    }
  })();
});

window.piVoice.onPlayAudioStreamChunk((pcmData) => {
  try {
    if (!audioContext) {
      audioContext = new AudioContext();
    }

    const raw = pcmData instanceof ArrayBuffer ? pcmData : new Uint8Array(pcmData as any).buffer;
    const bytesPerSample = streamBitsPerSample / 8;
    const sampleCount = raw.byteLength / bytesPerSample / streamChannels;

    if (sampleCount <= 0) return;

    // Create an AudioBuffer from raw PCM (16-bit signed LE)
    const audioBuffer = audioContext.createBuffer(
      streamChannels,
      sampleCount,
      streamSampleRate
    );

    const view = new DataView(raw);
    for (let ch = 0; ch < streamChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < sampleCount; i++) {
        const byteOffset = (i * streamChannels + ch) * bytesPerSample;
        const int16 = view.getInt16(byteOffset, true); // little-endian
        channelData[i] = int16 / 32768;
      }
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);

    // Schedule playback at the end of the current queue
    const now = audioContext.currentTime;
    if (streamNextPlayTime < now) {
      streamNextPlayTime = now;
    }

    source.start(streamNextPlayTime);
    streamNextPlayTime += audioBuffer.duration;

    streamActiveSources++;
    source.onended = () => {
      streamActiveSources--;
      if (streamEnded && streamActiveSources <= 0) {
        window.piVoice.sendPlaybackDone();
      }
    };
  } catch (err) {
    console.error("Stream chunk playback error:", err);
  }
});

window.piVoice.onPlayAudioStreamEnd(() => {
  streamEnded = true;
  // If all sources already finished (or no chunks received), signal done now
  if (streamActiveSources <= 0) {
    window.piVoice.sendPlaybackDone();
  }
});

// ── Calibration ───────────────────────────────────────────────────────
// Device labels are blank until some getUserMedia permission has been granted at least once for
// this origin; pi-voice's Electron session auto-grants (see main.ts), but the grant still has to
// actually happen before enumerateDevices() returns anything human-readable.

async function warmUpDeviceLabels(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
}

window.piVoice.onCalibrateListDevices(async () => {
  try {
    await warmUpDeviceLabels();
    const devices = await navigator.mediaDevices.enumerateDevices();
    window.piVoice.sendCalibrateDevicesList({
      inputs: devices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label || d.deviceId })),
      outputs: devices
        .filter((d) => d.kind === "audiooutput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label || d.deviceId })),
    });
  } catch (err) {
    console.error("Failed to list devices:", err);
    window.piVoice.sendCalibrateDevicesList({ inputs: [], outputs: [] });
  }
});

let calibrateStream: MediaStream | null = null;
let calibrateSourceNode: MediaStreamAudioSourceNode | null = null;
let calibrateAnalyser: AnalyserNode | null = null;
let calibrateLevelInterval: ReturnType<typeof setInterval> | null = null;

window.piVoice.onCalibrateTestInputStart(async (deviceId) => {
  try {
    const ctx = audioContext ?? new AudioContext();
    if (!audioContext) audioContext = ctx;

    calibrateStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
    });
    calibrateSourceNode = ctx.createMediaStreamSource(calibrateStream);
    calibrateAnalyser = ctx.createAnalyser();
    calibrateAnalyser.fftSize = 2048;
    calibrateSourceNode.connect(calibrateAnalyser);

    const buf = new Float32Array(calibrateAnalyser.fftSize);
    calibrateLevelInterval = setInterval(() => {
      if (!calibrateAnalyser) return;
      calibrateAnalyser.getFloatTimeDomainData(buf);
      let sumSquares = 0;
      for (const sample of buf) sumSquares += sample * sample;
      const rms = Math.sqrt(sumSquares / buf.length);
      window.piVoice.sendCalibrateInputLevel(rms);
    }, 100);
  } catch (err) {
    console.error("Calibrate input test failed to start:", err);
    window.piVoice.sendCalibrateInputLevel(0);
  }
});

window.piVoice.onCalibrateTestInputStop(() => {
  if (calibrateLevelInterval !== null) {
    clearInterval(calibrateLevelInterval);
    calibrateLevelInterval = null;
  }
  calibrateSourceNode?.disconnect();
  calibrateAnalyser?.disconnect();
  calibrateStream?.getTracks().forEach((track) => track.stop());
  calibrateSourceNode = null;
  calibrateAnalyser = null;
  calibrateStream = null;
});

window.piVoice.onCalibrateTestOutput(async (deviceId) => {
  try {
    const ctx = audioContext ?? new AudioContext();
    if (!audioContext) audioContext = ctx;

    if ("setSinkId" in ctx) {
      await (ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId);
    }

    const res = await fetch(toggleOnUrl);
    const buf = await res.arrayBuffer();
    const decoded = await ctx.decodeAudioData(buf);
    const source = ctx.createBufferSource();
    source.buffer = decoded;
    const gain = ctx.createGain();
    gain.gain.value = 2.0;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.onended = () => window.piVoice.sendCalibrateOutputDone();
    source.start();
  } catch (err) {
    console.error("Calibrate output test failed:", err);
    window.piVoice.sendCalibrateOutputDone();
  }
});
