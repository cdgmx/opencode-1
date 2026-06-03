import type { ToolPart } from "@opencode-ai/sdk/v2"

type ToolDict = Record<string, unknown>

export type CompactToolTime = {
  start?: number
  end?: number
}

export type CompactToolState = {
  status: string
  input?: ToolDict
  output?: string
  raw?: string
  title?: string
  error?: string
  metadata?: ToolDict
  time?: CompactToolTime
}

export type CompactToolPart = {
  id: string
  type: "tool"
  sessionID: string
  messageID: string
  callID: string
  tool: string
  metadata?: ToolDict
  state: CompactToolState
}

export function compactToolPart(part: ToolPart): CompactToolPart {
  return {
    id: part.id,
    type: "tool",
    sessionID: part.sessionID,
    messageID: part.messageID,
    callID: part.callID,
    tool: part.tool,
    ...(part.metadata ? { metadata: part.metadata as ToolDict } : {}),
    state: compactToolState(part),
  }
}

function compactToolState(part: ToolPart): CompactToolState {
  if (part.state.status === "pending") {
    return {
      status: "pending",
      input: part.state.input as ToolDict,
      raw: part.state.raw,
    }
  }

  if (part.state.status === "running") {
    return {
      status: "running",
      input: part.state.input as ToolDict,
      time: compactToolTime(part.state.time),
      ...(part.state.metadata ? { metadata: part.state.metadata as ToolDict } : {}),
      ...(part.state.title ? { title: part.state.title } : {}),
    }
  }

  if (part.state.status === "completed") {
    return {
      status: "completed",
      input: part.state.input as ToolDict,
      output: compactToolOutput(part.state.output),
      title: part.state.title,
      ...(part.state.metadata ? { metadata: part.state.metadata as ToolDict } : {}),
      time: compactToolTime(part.state.time),
    }
  }

  return {
    status: "error",
    input: part.state.input as ToolDict,
    error: part.state.error,
    ...(part.state.metadata ? { metadata: part.state.metadata as ToolDict } : {}),
    time: compactToolTime(part.state.time),
  }
}

function compactToolOutput(output: unknown) {
  if (typeof output === "string") {
    return output
  }

  if (output === undefined) {
    return undefined
  }

  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

function compactToolTime(time: { start?: unknown; end?: unknown } | undefined): CompactToolTime | undefined {
  if (!time) {
    return undefined
  }

  return {
    ...(typeof time.start === "number" ? { start: time.start } : {}),
    ...(typeof time.end === "number" ? { end: time.end } : {}),
  }
}
