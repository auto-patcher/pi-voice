import { describe, test, expect, beforeEach, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Mock logger
mock.module("../../services/logger.js", () => ({
  default: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

/**
 * Fakes a `pi -p --mode json ...` child process: a real EventEmitter (spawn()'s return value)
 * with real stdout/stderr streams, so pi-session.ts's actual `readline.createInterface` /
 * `.on("data", ...)` wiring runs unmodified against it.
 */
function mockChild(opts: { lines?: string[]; exitCode?: number; stderr?: string } = {}) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  queueMicrotask(() => {
    for (const line of opts.lines ?? []) {
      child.stdout.write(`${line}\n`);
    }
    child.stdout.end();
    if (opts.stderr) child.stderr.write(opts.stderr);
    child.stderr.end();
    child.emit("exit", opts.exitCode ?? 0);
  });

  return child;
}

const mockSpawn = mock((_cmd: string, _args: string[], _opts: unknown) => mockChild());

mock.module("node:child_process", () => ({
  spawn: mockSpawn,
}));

const { setSessionCwd, prompt, dispose } = await import("../../services/pi-session.js");

function textEndLine(content: string): string {
  return JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", content },
  });
}

describe("pi-session", () => {
  beforeEach(() => {
    dispose();
    mockSpawn.mockClear();
    mockSpawn.mockImplementation(() => mockChild());
  });

  describe("setSessionCwd", () => {
    test("does not throw", () => {
      expect(() => setSessionCwd("/test/dir")).not.toThrow();
    });
  });

  describe("prompt", () => {
    test("spawns pi with the prompt text and cwd", async () => {
      setSessionCwd("/my/project");
      await prompt("hello world");

      const call = mockSpawn.mock.calls[0] as unknown as [string, string[], { cwd: string }];
      expect(call[0]).toBe("pi");
      expect(call[1]).toContain("hello world");
      expect(call[2].cwd).toBe("/my/project");
    });

    test("reuses the same --session-id across calls", async () => {
      await prompt("first");
      await prompt("second");

      const args1 = (mockSpawn.mock.calls[0] as unknown as [string, string[]])[1];
      const args2 = (mockSpawn.mock.calls[1] as unknown as [string, string[]])[1];
      const sessionIdIndex = args1.indexOf("--session-id") + 1;
      expect(args1[sessionIdIndex]).toBe(args2[sessionIdIndex]);
    });

    test("dispose() causes the next prompt to use a new --session-id", async () => {
      await prompt("first");
      dispose();
      await prompt("second");

      const args1 = (mockSpawn.mock.calls[0] as unknown as [string, string[]])[1];
      const args2 = (mockSpawn.mock.calls[1] as unknown as [string, string[]])[1];
      const i = args1.indexOf("--session-id") + 1;
      expect(args1[i]).not.toBe(args2[i]);
    });

    test("calls onTextEnd for each text_end event", async () => {
      mockSpawn.mockImplementation(() => mockChild({ lines: [textEndLine("Hello from pi")] }));
      const onTextEnd = mock((_s: string) => {});

      await prompt("test", { onTextEnd });
      expect(onTextEnd).toHaveBeenCalledWith("Hello from pi");
    });

    test("calls onTextEnd once per text_end event, in order", async () => {
      mockSpawn.mockImplementation(() =>
        mockChild({ lines: [textEndLine("first sentence."), textEndLine("second sentence.")] }),
      );
      const segments: string[] = [];

      await prompt("test", { onTextEnd: (s) => void segments.push(s) });
      expect(segments).toEqual(["first sentence.", "second sentence."]);
    });

    test("skips empty content in text_end events", async () => {
      mockSpawn.mockImplementation(() => mockChild({ lines: [textEndLine("   ")] }));
      const onTextEnd = mock((_s: string) => {});

      await prompt("test", { onTextEnd });
      expect(onTextEnd).not.toHaveBeenCalled();
    });

    test("ignores non-JSON and unrelated event lines", async () => {
      mockSpawn.mockImplementation(() =>
        mockChild({
          lines: [
            "not json at all",
            JSON.stringify({ type: "agent_start" }),
            JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start" } }),
          ],
        }),
      );
      const onTextEnd = mock((_s: string) => {});

      await expect(prompt("test", { onTextEnd })).resolves.toBeUndefined();
      expect(onTextEnd).not.toHaveBeenCalled();
    });

    test("rejects when a turn_end event carries an errorMessage", async () => {
      mockSpawn.mockImplementation(() =>
        mockChild({
          lines: [
            JSON.stringify({ type: "turn_end", message: { errorMessage: "out of extra usage" } }),
          ],
        }),
      );

      await expect(prompt("test")).rejects.toThrow("out of extra usage");
    });

    test("rejects with stderr when pi exits non-zero and emitted no error event", async () => {
      mockSpawn.mockImplementation(() => mockChild({ exitCode: 1, stderr: "pi: command not found\n" }));

      await expect(prompt("test")).rejects.toThrow("pi: command not found");
    });

    test("rejects when spawn itself errors (pi not on PATH)", async () => {
      mockSpawn.mockImplementation(() => {
        // No scheduled "exit" here (unlike mockChild()) — only "error" should fire.
        const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit("error", new Error("spawn pi ENOENT"));
        });
        return child;
      });

      await expect(prompt("test")).rejects.toThrow("ENOENT");
    });
  });

  describe("dispose", () => {
    test("does nothing when no session exists", () => {
      expect(() => dispose()).not.toThrow();
    });
  });
});
