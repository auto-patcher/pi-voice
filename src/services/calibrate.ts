/**
 * `pi-voice calibrate` — interactive audio device picker.
 *
 * Chromium's own notion of the "default" input/output device doesn't reliably track the
 * system/PipeWire default (see config.ts's inputDeviceLabel/outputDeviceLabel doc comment), so
 * on a machine with more than one mic or speaker, `getUserMedia({ audio: true })` can silently
 * end up on the wrong one — the symptom is STT transcribing consistent near-silence (Whisper
 * hallucinates filler words like "you" on it) no matter what's actually said.
 *
 * This walks every enumerated device, one at a time:
 * - Input: opens it, watches RMS level in the renderer (renderer.ts) for a few seconds, and
 *   auto-advances on either a level spike (found it) or a timeout (try the next one) — no manual
 *   confirmation needed, it's genuinely listening.
 * - Output: plays a short tone through it and asks "did you hear that?" — there's no way to
 *   detect audio *output* without another mic listening for it, so this half is a real prompt.
 *
 * The result is written back to <cwd>/.pi/pi-voice.json as device *labels* (not deviceIds, which
 * aren't guaranteed stable across launches) via config.ts's saveDeviceCalibration.
 */
import { createInterface } from "node:readline/promises";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC, type AudioDeviceInfo, type CalibrateDevices } from "../shared/types.js";
import { saveDeviceCalibration } from "./config.js";
import logger from "./logger.js";

const INPUT_TEST_TIMEOUT_MS = 6000;
const INPUT_SETTLE_MS = 300; // ignore the first bit of each device (pop/click on stream open)
const INPUT_RMS_THRESHOLD = 0.02; // ~ -34dBFS; comfortably above room-noise floor, well below speech
const OUTPUT_TEST_TIMEOUT_MS = 5000;

function print(line = ""): void {
  process.stdout.write(`${line}\n`);
}

async function listDevices(win: BrowserWindow): Promise<CalibrateDevices> {
  return new Promise((resolve) => {
    ipcMain.once(IPC.CALIBRATE_DEVICES_LIST, (_event, devices: CalibrateDevices) => resolve(devices));
    win.webContents.send(IPC.CALIBRATE_LIST_DEVICES);
  });
}

/** Resolves true if a level spike was seen before the timeout, false otherwise. */
async function testInputDevice(win: BrowserWindow, device: AudioDeviceInfo): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let detected = false;
    let peak = 0;

    const onLevel = (_event: unknown, level: number) => {
      if (level > peak) peak = level;
      if (Date.now() - startedAt < INPUT_SETTLE_MS) return;
      if (level > INPUT_RMS_THRESHOLD) detected = true;
    };
    ipcMain.on(IPC.CALIBRATE_INPUT_LEVEL, onLevel);

    win.webContents.send(IPC.CALIBRATE_TEST_INPUT_START, device.deviceId);

    const poll = setInterval(() => {
      if (detected || Date.now() - startedAt > INPUT_TEST_TIMEOUT_MS) {
        clearInterval(poll);
        ipcMain.removeListener(IPC.CALIBRATE_INPUT_LEVEL, onLevel);
        win.webContents.send(IPC.CALIBRATE_TEST_INPUT_STOP);
        logger.info({ device: device.label, detected, peak }, "Calibrate input test");
        resolve(detected);
      }
    }, 100);
  });
}

async function testOutputDevice(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, OUTPUT_TEST_TIMEOUT_MS);
    ipcMain.once(IPC.CALIBRATE_OUTPUT_DONE, () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export interface CalibrateOptions {
  inputOnly?: boolean;
  outputOnly?: boolean;
}

export async function runCalibration(
  win: BrowserWindow,
  cwd: string,
  opts: CalibrateOptions = {},
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const doInput = !opts.outputOnly;
  const doOutput = !opts.inputOnly;

  try {
    print("Listing audio devices...");
    const devices = await listDevices(win);

    let inputDeviceLabel: string | undefined;
    let outputDeviceLabel: string | undefined;

    if (doInput) {
      print();
      print(`Found ${devices.inputs.length} input device(s).`);
      if (devices.inputs.length === 0) {
        print("No input devices found \u2014 skipping mic calibration.");
      } else {
        print("Testing each one \u2014 say something when prompted.");
        for (const [i, device] of devices.inputs.entries()) {
          print(`  [${i + 1}/${devices.inputs.length}] ${device.label} \u2014 speak now...`);
          const detected = await testInputDevice(win, device);
          if (detected) {
            print(`  \u2713 Got a signal on "${device.label}".`);
            inputDeviceLabel = device.label;
            break;
          }
          print("    (no signal, trying the next one)");
        }

        if (!inputDeviceLabel) {
          print();
          print("Didn't detect speech on any device automatically.");
          inputDeviceLabel = await pickManually(rl, devices.inputs);
        }
      }
    }

    if (doOutput) {
      print();
      print(`Found ${devices.outputs.length} output device(s).`);
      if (devices.outputs.length === 0) {
        print("No output devices found \u2014 skipping speaker calibration.");
      } else {
        print("Playing a tone through each one.");
        for (const [i, device] of devices.outputs.entries()) {
          print(`  [${i + 1}/${devices.outputs.length}] ${device.label} \u2014 playing tone...`);
          win.webContents.send(IPC.CALIBRATE_TEST_OUTPUT, device.deviceId);
          await testOutputDevice(win);
          const answer = (await rl.question("    Did you hear that? [y/N] ")).trim().toLowerCase();
          if (answer === "y" || answer === "yes") {
            outputDeviceLabel = device.label;
            print(`  \u2713 Using "${device.label}".`);
            break;
          }
        }

        if (!outputDeviceLabel) {
          print();
          print("Didn't get a confirmation for any device.");
          outputDeviceLabel = await pickManually(rl, devices.outputs);
        }
      }
    }

    if (inputDeviceLabel || outputDeviceLabel) {
      saveDeviceCalibration(cwd, { inputDeviceLabel, outputDeviceLabel });
      print();
      print(`Saved to ${cwd}/.pi/pi-voice.json:`);
      if (inputDeviceLabel) print(`  input:  ${inputDeviceLabel}`);
      if (outputDeviceLabel) print(`  output: ${outputDeviceLabel}`);
    } else {
      print();
      print("Nothing calibrated \u2014 config left unchanged.");
    }
  } finally {
    rl.close();
  }
}

async function pickManually(
  rl: ReturnType<typeof createInterface>,
  devices: AudioDeviceInfo[],
): Promise<string | undefined> {
  if (devices.length === 0) return undefined;
  print("Pick one manually, or leave blank to skip:");
  for (const [i, device] of devices.entries()) {
    print(`  ${i + 1}. ${device.label}`);
  }
  const answer = (await rl.question("> ")).trim();
  const index = Number.parseInt(answer, 10) - 1;
  if (Number.isInteger(index) && index >= 0 && index < devices.length) {
    return devices[index]?.label;
  }
  return undefined;
}
