import { describe, test, expect, beforeEach, mock } from "bun:test";

// Mock logger
mock.module("../../services/logger.js", () => ({
  default: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// Mock the pi coding agent SDK
const mockDispose = mock(() => {});
const mockPrompt = mock(async (_text: string) => {});
const mockSubscribe = mock((_cb: any) => {
  return () => {}; // unsubscribe
});

const mockSession = {
  dispose: mockDispose,
  prompt: mockPrompt,
  subscribe: mockSubscribe,
};

const mockCreateAgentSession = mock(async (_opts: any) => ({
  session: mockSession,
  extensionsResult: { extensions: [], errors: [] },
}));

const mockSessionManagerInMemory = mock(() => ({}));

mock.module("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mockCreateAgentSession,
  SessionManager: {
    inMemory: mockSessionManagerInMemory,
  },
}));

const {
  setSessionCwd,
  getOrCreateSession,
  prompt,
  dispose,
} = await import("../../services/pi-session.js");

describe("pi-session", () => {
  beforeEach(() => {
    dispose(); // reset cached session
    mockCreateAgentSession.mockClear();
    mockCreateAgentSession.mockImplementation(async (_opts: any) => ({
      session: mockSession,
      extensionsResult: { extensions: [], errors: [] },
    }));
    mockDispose.mockClear();
    mockPrompt.mockClear();
    mockPrompt.mockImplementation(async () => {});
    mockSubscribe.mockClear();
    mockSubscribe.mockImplementation((_cb: any) => () => {});
  });

  describe("setSessionCwd", () => {
    test("does not throw", () => {
      expect(() => setSessionCwd("/test/dir")).not.toThrow();
    });
  });

  describe("getOrCreateSession", () => {
    test("creates a session on first call", async () => {
      const session = await getOrCreateSession();
      expect(session).toBeDefined();
      expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
    });

    test("returns cached session on subsequent calls", async () => {
      const s1 = await getOrCreateSession();
      const s2 = await getOrCreateSession();
      expect(s1).toBe(s2);
      expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
    });

    test("passes cwd to createAgentSession", async () => {
      setSessionCwd("/my/project");
      await getOrCreateSession();
      const calls = mockCreateAgentSession.mock.calls as any[];
      expect(calls[0]![0].cwd).toBe("/my/project");
    });

    test("uses in-memory session manager", async () => {
      await getOrCreateSession();
      expect(mockSessionManagerInMemory).toHaveBeenCalled();
    });

    test("logs a warning but does not throw when extensions fail to load", async () => {
      mockCreateAgentSession.mockImplementation(async () => ({
        session: mockSession,
        extensionsResult: {
          extensions: [],
          errors: [{ path: "/some/ext.ts", error: "boom" }],
        },
      }));
      await expect(getOrCreateSession()).resolves.toBeDefined();
    });
  });

  describe("prompt", () => {
    test("calls session.prompt with the text", async () => {
      await prompt("hello world");
      const calls = mockPrompt.mock.calls as any[];
      expect(calls[0]![0]).toBe("hello world");
    });

    test("subscribes before prompting and unsubscribes after", async () => {
      const unsubscribeFn = mock(() => {});
      mockSubscribe.mockImplementation(() => unsubscribeFn);

      await prompt("test");

      expect(mockSubscribe).toHaveBeenCalledTimes(1);
      expect(unsubscribeFn).toHaveBeenCalledTimes(1);
    });

    test("unsubscribes even if prompt throws", async () => {
      const unsubscribeFn = mock(() => {});
      mockSubscribe.mockImplementation(() => unsubscribeFn);
      mockPrompt.mockImplementation(async () => {
        throw new Error("prompt failed");
      });

      await expect(prompt("fail")).rejects.toThrow("prompt failed");
      expect(unsubscribeFn).toHaveBeenCalledTimes(1);
    });

    test("calls onTextEnd callback for text_end events", async () => {
      const onTextEnd = mock((_s: string) => {});

      mockSubscribe.mockImplementation((cb: any) => {
        cb({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_end",
            content: "Hello from pi",
          },
        });
        return () => {};
      });

      await prompt("test", { onTextEnd });
      expect(onTextEnd).toHaveBeenCalledWith("Hello from pi");
    });

    test("skips empty content in text_end events", async () => {
      const onTextEnd = mock((_s: string) => {});

      mockSubscribe.mockImplementation((cb: any) => {
        cb({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_end",
            content: "   ",
          },
        });
        return () => {};
      });

      await prompt("test", { onTextEnd });
      expect(onTextEnd).not.toHaveBeenCalled();
    });

    test("ignores non-text_end events", async () => {
      const onTextEnd = mock((_s: string) => {});

      mockSubscribe.mockImplementation((cb: any) => {
        cb({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_start",
            content: "start",
          },
        });
        return () => {};
      });

      await prompt("test", { onTextEnd });
      expect(onTextEnd).not.toHaveBeenCalled();
    });

    // The whole reason prompt() tracks turn_end separately: a turn that errors out (auth,
    // quota, network) produces zero text_end events, which previously looked identical to
    // "the model just said nothing" -- see pi-session.ts header comment.
    describe("turn_end error surfacing", () => {
      test("rejects when a turn_end event carries an errorMessage", async () => {
        mockSubscribe.mockImplementation((cb: any) => {
          cb({ type: "turn_end", message: { errorMessage: "out of extra usage" } });
          return () => {};
        });

        await expect(prompt("test")).rejects.toThrow("out of extra usage");
      });

      test("does not reject when turn_end has no errorMessage", async () => {
        mockSubscribe.mockImplementation((cb: any) => {
          cb({ type: "turn_end", message: {} });
          return () => {};
        });

        await expect(prompt("test")).resolves.toBeUndefined();
      });

      test("still delivers any text_end segments that arrived before the error", async () => {
        const onTextEnd = mock((_s: string) => {});
        mockSubscribe.mockImplementation((cb: any) => {
          cb({
            type: "message_update",
            assistantMessageEvent: { type: "text_end", content: "partial answer" },
          });
          cb({ type: "turn_end", message: { errorMessage: "network error" } });
          return () => {};
        });

        await expect(prompt("test", { onTextEnd })).rejects.toThrow("network error");
        expect(onTextEnd).toHaveBeenCalledWith("partial answer");
      });
    });
  });

  describe("dispose", () => {
    test("disposes the session", async () => {
      await getOrCreateSession();
      dispose();
      expect(mockDispose).toHaveBeenCalledTimes(1);
    });

    test("does nothing when no session exists", () => {
      expect(() => dispose()).not.toThrow();
    });

    test("allows creating new session after dispose", async () => {
      await getOrCreateSession();
      dispose();
      mockCreateAgentSession.mockClear();

      await getOrCreateSession();
      expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
    });
  });
});
