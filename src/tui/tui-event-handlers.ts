import {
  asString,
  extractTextFromMessage,
  isCommandMessage,
  extractToolCallsFromText,
} from "./tui-formatters.js";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";
import type { AgentEvent, ChatEvent, TuiStateAccess } from "./tui-types.js";

type EventHandlerChatLog = {
  startTool: (toolCallId: string, toolName: string, args: unknown) => void;
  updateToolResult: (
    toolCallId: string,
    result: unknown,
    options?: { partial?: boolean; isError?: boolean },
  ) => void;
  addSystem: (text: string) => void;
  updateAssistant: (text: string, runId: string) => void;
  finalizeAssistant: (text: string, runId: string) => void;
  dropAssistant: (runId: string) => void;
};

type EventHandlerTui = {
  requestRender: () => void;
};

type EventHandlerContext = {
  chatLog: EventHandlerChatLog;
  tui: EventHandlerTui;
  state: TuiStateAccess;
  setActivityStatus: (text: string) => void;
  refreshSessionInfo?: () => Promise<void>;
  loadHistory?: () => Promise<void>;
  isLocalRunId?: (runId: string) => boolean;
  forgetLocalRunId?: (runId: string) => void;
  clearLocalRunIds?: () => void;
  sendToolResultMessage?: (resultText: string) => Promise<void>;
};

export function createEventHandlers(context: EventHandlerContext) {
  const {
    chatLog,
    tui,
    state,
    setActivityStatus,
    refreshSessionInfo,
    loadHistory,
    isLocalRunId,
    forgetLocalRunId,
    clearLocalRunIds,
    sendToolResultMessage,
  } = context;
  const finalizedRuns = new Map<string, number>();
  const sessionRuns = new Map<string, number>();
  let streamAssembler = new TuiStreamAssembler();
  let lastSessionKey = state.currentSessionKey;

  const pruneRunMap = (runs: Map<string, number>) => {
    if (runs.size <= 200) {
      return;
    }
    const keepUntil = Date.now() - 10 * 60 * 1000;
    for (const [key, ts] of runs) {
      if (runs.size <= 150) {
        break;
      }
      if (ts < keepUntil) {
        runs.delete(key);
      }
    }
    if (runs.size > 200) {
      for (const key of runs.keys()) {
        runs.delete(key);
        if (runs.size <= 150) {
          break;
        }
      }
    }
  };

  const syncSessionKey = () => {
    if (state.currentSessionKey === lastSessionKey) {
      return;
    }
    lastSessionKey = state.currentSessionKey;
    finalizedRuns.clear();
    sessionRuns.clear();
    streamAssembler = new TuiStreamAssembler();
    clearLocalRunIds?.();
  };

  const noteSessionRun = (runId: string) => {
    sessionRuns.set(runId, Date.now());
    pruneRunMap(sessionRuns);
  };

  const noteFinalizedRun = (runId: string) => {
    finalizedRuns.set(runId, Date.now());
    sessionRuns.delete(runId);
    streamAssembler.drop(runId);
    pruneRunMap(finalizedRuns);
  };

  const clearActiveRunIfMatch = (runId: string) => {
    if (state.activeChatRunId === runId) {
      state.activeChatRunId = null;
    }
  };

  const hasConcurrentActiveRun = (runId: string) => {
    const activeRunId = state.activeChatRunId;
    if (!activeRunId || activeRunId === runId) {
      return false;
    }
    return sessionRuns.has(activeRunId);
  };

  const maybeRefreshHistoryForRun = (runId: string) => {
    if (isLocalRunId?.(runId)) {
      forgetLocalRunId?.(runId);
      return;
    }
    if (hasConcurrentActiveRun(runId)) {
      return;
    }
    void loadHistory?.();
  };

  const handleChatEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as ChatEvent;
    syncSessionKey();
    if (evt.sessionKey !== state.currentSessionKey) {
      return;
    }
    if (finalizedRuns.has(evt.runId)) {
      if (evt.state === "delta") {
        return;
      }
      if (evt.state === "final") {
        return;
      }
    }
    noteSessionRun(evt.runId);
    if (!state.activeChatRunId) {
      state.activeChatRunId = evt.runId;
    }
    if (evt.state === "delta") {
      const displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
      if (!displayText) {
        return;
      }
      chatLog.updateAssistant(displayText, evt.runId);
      setActivityStatus("streaming");
    }
    if (evt.state === "final") {
      const wasActiveRun = state.activeChatRunId === evt.runId;
      if (!evt.message) {
        maybeRefreshHistoryForRun(evt.runId);
        chatLog.dropAssistant(evt.runId);
        noteFinalizedRun(evt.runId);
        clearActiveRunIfMatch(evt.runId);
        if (wasActiveRun) {
          setActivityStatus("idle");
        }
        void refreshSessionInfo?.();
        tui.requestRender();
        return;
      }
      if (isCommandMessage(evt.message)) {
        maybeRefreshHistoryForRun(evt.runId);
        const text = extractTextFromMessage(evt.message);
        if (text) {
          chatLog.addSystem(text);
        }
        streamAssembler.drop(evt.runId);
        noteFinalizedRun(evt.runId);
        clearActiveRunIfMatch(evt.runId);
        if (wasActiveRun) {
          setActivityStatus("idle");
        }
        void refreshSessionInfo?.();
        tui.requestRender();
        return;
      }
      maybeRefreshHistoryForRun(evt.runId);
      const stopReason =
        evt.message && typeof evt.message === "object" && !Array.isArray(evt.message)
          ? typeof (evt.message as Record<string, unknown>).stopReason === "string"
            ? ((evt.message as Record<string, unknown>).stopReason as string)
            : ""
          : "";

      const finalText = streamAssembler.finalize(evt.runId, evt.message, state.showThinking);
      const suppressEmptyExternalPlaceholder =
        finalText === "(no output)" && !isLocalRunId?.(evt.runId);
      if (suppressEmptyExternalPlaceholder) {
        chatLog.dropAssistant(evt.runId);
      } else {
        chatLog.finalizeAssistant(finalText, evt.runId);
      }

      // Extract and execute tool calls from markdown format (e.g., gemma3-tools)
      const extractedToolCalls = extractToolCallsFromText(finalText);
      for (const toolCall of extractedToolCalls) {
        const toolCallId = `${evt.runId}-${toolCall.name}-${Date.now()}`;
        chatLog.startTool(toolCallId, toolCall.name, toolCall.parameters);

        // Execute tool (currently only supports "exec")
        if (toolCall.name === "exec" && typeof toolCall.parameters?.command === "string") {
          // Import child_process dynamically to execute command
          void (async () => {
            try {
              const { exec } = await import("node:child_process");
              const { promisify } = await import("node:util");
              const execAsync = promisify(exec);
              const { stdout, stderr } = await execAsync(toolCall.parameters.command as string, {
                timeout: 30000,
              });
              const result = stdout || "(no output)";
              chatLog.updateToolResult(toolCallId, {
                content: result,
                stderr: stderr || undefined,
              });

              // Send result back to agent so it can process and continue
              if (sendToolResultMessage) {
                await sendToolResultMessage(
                  `Tool result from exec:\n${result}${stderr ? `\nStderr: ${stderr}` : ""}`,
                );
              }
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              chatLog.updateToolResult(
                toolCallId,
                {
                  content: `Error executing command: ${errorMsg}`,
                },
                { isError: true },
              );

              // Send error back to agent
              if (sendToolResultMessage) {
                await sendToolResultMessage(`Tool error from exec: ${errorMsg}`);
              }
            }
          })();
        }
      }

      noteFinalizedRun(evt.runId);
      clearActiveRunIfMatch(evt.runId);
      if (wasActiveRun) {
        setActivityStatus(stopReason === "error" ? "error" : "idle");
      }
      // Refresh session info to update token counts in footer
      void refreshSessionInfo?.();
    }
    if (evt.state === "aborted") {
      const wasActiveRun = state.activeChatRunId === evt.runId;
      chatLog.addSystem("run aborted");
      streamAssembler.drop(evt.runId);
      sessionRuns.delete(evt.runId);
      clearActiveRunIfMatch(evt.runId);
      if (wasActiveRun) {
        setActivityStatus("aborted");
      }
      void refreshSessionInfo?.();
      maybeRefreshHistoryForRun(evt.runId);
    }
    if (evt.state === "error") {
      const wasActiveRun = state.activeChatRunId === evt.runId;
      chatLog.addSystem(`run error: ${evt.errorMessage ?? "unknown"}`);
      streamAssembler.drop(evt.runId);
      sessionRuns.delete(evt.runId);
      clearActiveRunIfMatch(evt.runId);
      if (wasActiveRun) {
        setActivityStatus("error");
      }
      void refreshSessionInfo?.();
      maybeRefreshHistoryForRun(evt.runId);
    }
    tui.requestRender();
  };

  const handleAgentEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as AgentEvent;
    syncSessionKey();
    // Agent events (tool streaming, lifecycle) are emitted per-run. Filter against the
    // active chat run id, not the session id. Tool results can arrive after the chat
    // final event, so accept finalized runs for tool updates.
    const isActiveRun = evt.runId === state.activeChatRunId;
    const isKnownRun = isActiveRun || sessionRuns.has(evt.runId) || finalizedRuns.has(evt.runId);
    if (!isKnownRun) {
      return;
    }
    if (evt.stream === "tool") {
      const verbose = state.sessionInfo.verboseLevel ?? "off";
      const allowToolEvents = verbose !== "off";
      const allowToolOutput = verbose === "full";
      if (!allowToolEvents) {
        return;
      }
      const data = evt.data ?? {};
      const phase = asString(data.phase, "");
      const toolCallId = asString(data.toolCallId, "");
      const toolName = asString(data.name, "tool");
      if (!toolCallId) {
        return;
      }
      if (phase === "start") {
        chatLog.startTool(toolCallId, toolName, data.args);
      } else if (phase === "update") {
        if (!allowToolOutput) {
          return;
        }
        chatLog.updateToolResult(toolCallId, data.partialResult, {
          partial: true,
        });
      } else if (phase === "result") {
        if (allowToolOutput) {
          chatLog.updateToolResult(toolCallId, data.result, {
            isError: Boolean(data.isError),
          });
        } else {
          chatLog.updateToolResult(toolCallId, { content: [] }, { isError: Boolean(data.isError) });
        }
      }
      tui.requestRender();
      return;
    }
    if (evt.stream === "lifecycle") {
      if (!isActiveRun) {
        return;
      }
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (phase === "start") {
        setActivityStatus("running");
      }
      if (phase === "end") {
        setActivityStatus("idle");
      }
      if (phase === "error") {
        setActivityStatus("error");
      }
      tui.requestRender();
    }
  };

  return { handleChatEvent, handleAgentEvent };
}
