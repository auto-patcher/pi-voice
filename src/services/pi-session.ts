/**
 * Talks to the real `pi` CLI as a child process, not the bundled `@mariozechner/pi-coding-agent`
 * SDK this package still depends on for its types.
 *
 * Why: that SDK bundles its own, much older model catalog (as of this package's pinned
 * ^0.52.7, it doesn't even know the "claude-sonnet-5" model ID a current `pi` install's
 * settings.json configures) and its own auth/extension system, which has no way to load
 * `pi-black` or anything else a real `pi` setup relies on. `createAgentSession()`'s own
 * documented behavior for an unrecognized configured model is "default: from settings, else
 * first available" -- silently falling back to whatever model that resolves to, in practice an
 * expensive one with its own separate, easily-exhausted usage allowance, producing a 400 that
 * looks identical to "the model said nothing" from pi-voice's perspective (no assistant text,
 * no thrown error). None of this reproduces with the real `pi` CLI, which uses eva's actual
 * settings.json, model catalog, and pi-black routing.
 *
 * `pi -p --mode json` turns out to emit the exact same event schema the SDK's own
 * `session.subscribe()` does (message_update/text_start/text_delta/text_end, turn_end,
 * agent_end, ...) -- shared lineage, not a coincidence -- so this is a drop-in swap: same
 * `onTextEnd` callback contract, but with byte-for-byte parity to a manual `pi -p` invocation
 * instead of a second, drifting implementation of "what pi does."
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import logger from "./logger.js";

let sessionCwd: string = process.cwd();
let sessionId: string | null = null;

/**
 * Set the working directory used when invoking `pi`.
 * Must be called before the first prompt() call.
 */
export function setSessionCwd(cwd: string): void {
  sessionCwd = cwd;
}

export interface PromptOptions {
  /** Called each time a text block completes (text_end event). */
  onTextEnd?: (segment: string) => void | Promise<void>;
}

interface TextEndEvent {
  type: "message_update";
  assistantMessageEvent: { type: "text_end"; content: string };
}

interface TurnEndEvent {
  type: "turn_end";
  message: { errorMessage?: string };
}

function isTextEnd(event: unknown): event is TextEndEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { type?: unknown }).type === "message_update" &&
    (event as { assistantMessageEvent?: { type?: unknown } }).assistantMessageEvent?.type === "text_end"
  );
}

function isTurnEnd(event: unknown): event is TurnEndEvent {
  return typeof event === "object" && event !== null && (event as { type?: unknown }).type === "turn_end";
}

/**
 * Send a prompt to `pi`, continuing the same `--session-id` across calls within this process's
 * lifetime so multi-turn context carries over exactly like a persistent AgentSession would.
 * `onTextEnd` is called for each completed text segment so callers can start TTS incrementally
 * without waiting for the full response.
 */
export async function prompt(text: string, options?: PromptOptions): Promise<void> {
  if (!sessionId) sessionId = randomUUID();

  logger.info({ cwd: sessionCwd, sessionId }, "Prompting pi");

  const child = spawn("pi", ["-p", "--mode", "json", "--session-id", sessionId, text], {
    cwd: sessionCwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const rl = createInterface({ input: child.stdout });
  let turnError: string | undefined;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return; // pi shouldn't emit non-JSON lines in --mode json, but don't choke if it does
    }

    if (isTextEnd(event)) {
      const content = event.assistantMessageEvent.content.trim();
      if (content.length > 0) {
        logger.info({ content }, "Agent response");
        options?.onTextEnd?.(content);
      }
    } else if (isTurnEnd(event) && event.message.errorMessage) {
      turnError = event.message.errorMessage;
    }
  });

  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.on("error", reject); // e.g. `pi` not on PATH
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(turnError ?? stderr.trim() ?? `pi exited with code ${exitCode}`);
  }
  if (turnError) {
    throw new Error(turnError);
  }
}

/**
 * Drop the session ID, so the next prompt() starts a fresh `pi` conversation instead of
 * continuing the old one.
 */
export function dispose(): void {
  if (sessionId) {
    logger.info({ sessionId }, "Agent session disposed");
    sessionId = null;
  }
}
