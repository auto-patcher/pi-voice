import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type PiVoiceAPI,
  type AudioStreamMeta,
  type RecordingFormat,
  type CalibrateDevices,
} from "./shared/types.js";

const api: PiVoiceAPI = {
  onStartRecording: (callback) => {
    ipcRenderer.on(IPC.START_RECORDING, (_event, format: RecordingFormat, inputDeviceLabel?: string) =>
      callback(format ?? "webm", inputDeviceLabel),
    );
  },
  onStopRecording: (callback) => {
    ipcRenderer.on(IPC.STOP_RECORDING, () => callback());
  },
  onPlayAudioStreamStart: (callback) => {
    ipcRenderer.on(
      IPC.PLAY_AUDIO_STREAM_START,
      (_event, meta: AudioStreamMeta) => callback(meta)
    );
  },
  onPlayAudioStreamChunk: (callback) => {
    ipcRenderer.on(
      IPC.PLAY_AUDIO_STREAM_CHUNK,
      (_event, pcmData: ArrayBuffer) => callback(pcmData)
    );
  },
  onPlayAudioStreamEnd: (callback) => {
    ipcRenderer.on(IPC.PLAY_AUDIO_STREAM_END, () => callback());
  },
  sendRecordingData: (data) => {
    ipcRenderer.send(IPC.RECORDING_DATA, data);
  },
  sendRecordingError: (error) => {
    ipcRenderer.send(IPC.RECORDING_ERROR, error);
  },
  sendPlaybackDone: () => {
    ipcRenderer.send(IPC.PLAYBACK_DONE);
  },

  onCalibrateListDevices: (callback) => {
    ipcRenderer.on(IPC.CALIBRATE_LIST_DEVICES, () => callback());
  },
  sendCalibrateDevicesList: (devices: CalibrateDevices) => {
    ipcRenderer.send(IPC.CALIBRATE_DEVICES_LIST, devices);
  },
  onCalibrateTestInputStart: (callback) => {
    ipcRenderer.on(IPC.CALIBRATE_TEST_INPUT_START, (_event, deviceId: string) => callback(deviceId));
  },
  onCalibrateTestInputStop: (callback) => {
    ipcRenderer.on(IPC.CALIBRATE_TEST_INPUT_STOP, () => callback());
  },
  sendCalibrateInputLevel: (level: number) => {
    ipcRenderer.send(IPC.CALIBRATE_INPUT_LEVEL, level);
  },
  onCalibrateTestOutput: (callback) => {
    ipcRenderer.on(IPC.CALIBRATE_TEST_OUTPUT, (_event, deviceId: string) => callback(deviceId));
  },
  sendCalibrateOutputDone: () => {
    ipcRenderer.send(IPC.CALIBRATE_OUTPUT_DONE);
  },
};

contextBridge.exposeInMainWorld("piVoice", api);
