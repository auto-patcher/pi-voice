/** Application state machine */
export type AppState =
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

/**
 * Recording format sent from main to renderer.
 * - "webm": MediaRecorder with audio/webm;codecs=opus (for cloud providers)
 * - "pcm":  Raw 16kHz mono Float32 PCM via Web Audio API (for local Whisper)
 */
export type RecordingFormat = "webm" | "pcm";

/** IPC channel names */
export const IPC = {
  // main -> renderer
  START_RECORDING: "start-recording",
  STOP_RECORDING: "stop-recording",
  PLAY_AUDIO_STREAM_START: "play-audio-stream-start",
  PLAY_AUDIO_STREAM_CHUNK: "play-audio-stream-chunk",
  PLAY_AUDIO_STREAM_END: "play-audio-stream-end",

  // renderer -> main
  RECORDING_DATA: "recording-data",
  RECORDING_ERROR: "recording-error",
  PLAYBACK_DONE: "playback-done",

  // calibrate: main -> renderer
  CALIBRATE_LIST_DEVICES: "calibrate-list-devices",
  CALIBRATE_TEST_INPUT_START: "calibrate-test-input-start",
  CALIBRATE_TEST_INPUT_STOP: "calibrate-test-input-stop",
  CALIBRATE_TEST_OUTPUT: "calibrate-test-output",

  // calibrate: renderer -> main
  CALIBRATE_DEVICES_LIST: "calibrate-devices-list",
  CALIBRATE_INPUT_LEVEL: "calibrate-input-level",
  CALIBRATE_OUTPUT_DONE: "calibrate-output-done",
} as const;

/** Audio stream metadata sent at the start of a streaming TTS session */
export interface AudioStreamMeta {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /**
   * Output device label to play through (from calibrate, ../services/config.ts).
   * Renderer resolves this to a live deviceId via enumerateDevices() at play time —
   * deviceIds aren't guaranteed stable across launches, labels are what a human picked.
   */
  outputDeviceLabel?: string;
}

/** A single entry from MediaDevices.enumerateDevices(), input or output. */
export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
}

export interface CalibrateDevices {
  inputs: AudioDeviceInfo[];
  outputs: AudioDeviceInfo[];
}

/** Exposed API in renderer via contextBridge */
export interface PiVoiceAPI {
  onStartRecording: (callback: (format: RecordingFormat, inputDeviceLabel?: string) => void) => void;
  onStopRecording: (callback: () => void) => void;
  onPlayAudioStreamStart: (callback: (meta: AudioStreamMeta) => void) => void;
  onPlayAudioStreamChunk: (callback: (pcmData: ArrayBuffer) => void) => void;
  onPlayAudioStreamEnd: (callback: () => void) => void;
  sendRecordingData: (data: ArrayBuffer) => void;
  sendRecordingError: (error: string) => void;
  sendPlaybackDone: () => void;

  onCalibrateListDevices: (callback: () => void) => void;
  sendCalibrateDevicesList: (devices: CalibrateDevices) => void;
  onCalibrateTestInputStart: (callback: (deviceId: string) => void) => void;
  onCalibrateTestInputStop: (callback: () => void) => void;
  sendCalibrateInputLevel: (level: number) => void;
  onCalibrateTestOutput: (callback: (deviceId: string) => void) => void;
  sendCalibrateOutputDone: () => void;
}

declare global {
  interface Window {
    piVoice: PiVoiceAPI;
  }
}
