/**
 * Talks to the real pi coding agent via `@earendil-works/pi-coding-agent` (SDK embedding, not
 * shelling out to the `pi` CLI). Two things have to be true for this to work correctly rather
 * than silently misbehave, both nailed down by direct testing:
 *
 * 1. It must be pinned to *exactly* the version pi-black expects (currently 0.84.1 -- see
 *    SUPPORTED_PI_VERSION in paoloanzn/pi-black's src/claude-code-protocol.ts). package.json
 *    pins `@earendil-works/pi-coding-agent` and every `@earendil-works/*` sibling it transitively
 *    depends on to the exact same version (no `^` ranges) for this reason -- a caret range lets
 *    bun float individual siblings to a newer patch even when the top-level package is pinned.
 *
 * 2. `~/.pi/agent` (or wherever `agentDir` points) needs a `node_modules/@earendil-works/
 *    pi-coding-agent` reachable via a plain directory walk-up from wherever its git-installed
 *    extensions live (e.g. `~/.pi/agent/git/github.com/paoloanzn/pi-black/extensions/`).
 *    createAgentSession()'s extension loader (jiti, with an alias map pointing bare
 *    `@earendil-works/pi-coding-agent` imports at this package's own dist/index.js) doesn't
 *    reliably win over plain Node/Bun module resolution for imports *inside* a loaded
 *    extension -- when the extension's own directory has no reachable node_modules at all
 *    (true for anything under `~/.pi/agent/git/...`, which has none in its ancestry), resolution
 *    falls through to some other, uncontrolled instance (e.g. Bun's global install cache) instead
 *    of the alias target, and pi-black's own version check then sees a version pi-voice never
 *    installed and never agreed to. This isn't pi-voice's job to fix directly -- (2) has to be
 *    provisioned externally (see dotfiles' module/pi-coding-agent-sdk.nix, which drops a matching
 *    node_modules there declaratively) -- but it's why pi-voice pins so precisely per (1): the
 *    provisioned copy and this package's own version must match exactly, or the two problems
 *    compound instead of cancel out.
 *
 * Once both are true, this doesn't just work as well as shelling out to `pi -p` -- it's strictly
 * better: no per-turn subprocess spawn, and no equivalent of the `pi -p`-mode bug where a
 * tool-using turn exits without ever producing the model's follow-up text (confirmed: multi-turn
 * tool use completes correctly in a single session.prompt() call here).
 */
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import logger from "./logger.js";

let session: AgentSession | null = null;
let sessionCwd: string = process.cwd();

/**
 * Set the working directory used when creating the agent session.
 * Must be called before the first getOrCreateSession() call.
 */
export function setSessionCwd(cwd: string): void {
  sessionCwd = cwd;
}

/**
 * Initialize (or reuse) a pi coding agent session.
 * Uses default discovery for skills, extensions, tools, context files.
 */
export async function getOrCreateSession(): Promise<AgentSession> {
  if (session) return session;

  logger.info({ cwd: sessionCwd }, "Creating new agent session");
  const result = await createAgentSession({
    cwd: sessionCwd,
    sessionManager: SessionManager.inMemory(),
  });
  if (result.extensionsResult.errors.length > 0) {
    logger.warn({ errors: result.extensionsResult.errors }, "Extension load errors");
  }
  session = result.session;
  logger.info("Agent session created");
  return session;
}

export interface PromptOptions {
  /** Called each time a text block completes (text_end event). */
  onTextEnd?: (segment: string) => void | Promise<void>;
}

/**
 * Send a prompt to pi.
 * `onTextEnd` is called for each completed text segment so callers can
 * start TTS incrementally without waiting for the full response.
 * Throws if the turn ends with an error (e.g. auth/quota failures) -- a turn that errors
 * produces no text_end events, which would otherwise look identical to "the model said nothing".
 */
export async function prompt(
  text: string,
  options?: PromptOptions,
): Promise<void> {
  const s = await getOrCreateSession();

  let turnError: string | undefined;
  const unsubscribe = s.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_end"
    ) {
      const content = event.assistantMessageEvent.content.trim();
      if (content.length > 0) {
        logger.info({ content }, "Agent response");
        options?.onTextEnd?.(content);
      }
    } else if (event.type === "turn_end" && event.message.errorMessage) {
      turnError = event.message.errorMessage;
    }
  });

  try {
    await s.prompt(text);
  } finally {
    unsubscribe();
  }

  if (turnError) {
    throw new Error(turnError);
  }
}

/**
 * Dispose the current session.
 */
export function dispose(): void {
  if (session) {
    session.dispose();
    session = null;
    logger.info("Agent session disposed");
  }
}
