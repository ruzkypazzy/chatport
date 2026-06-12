// Normalize an OpenAI or MiniMax-M3 conversation + items response into chatport's
// SessionBlob shape. Both providers are OpenAI-compatible, so the parsing is
// shared; provider-specific quirks (e.g. role names) are handled inline.
import type { Message, SessionBlob, SourceLlm } from "../types.js";

interface ParsedConversation {
  id: string;
  created_at?: number;
  metadata?: unknown;
}

interface ParsedItem {
  type?: string;
  role?: string;
  content?: unknown;
  created_at?: number;
  // For pagination cursor
  id?: string;
}

/**
 * Pull a text payload out of an OpenAI Message.content array. The SDK types
 * the content as a union, so we duck-type to extract `.text` from each
 * text-like variant and join them with newlines.
 */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part !== null && typeof part === "object" && "text" in part) {
      const t = (part as { text: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n");
}

/**
 * Map an upstream role string to one of our 4 valid roles. Anything else
 * (e.g. `developer`, `critic`, `discriminator`, `unknown`) is folded into
 * `system` to keep the SessionBlob shape stable.
 */
function normalizeRole(role: string | undefined): Message["role"] {
  switch (role) {
    case "user":
    case "assistant":
    case "system":
    case "tool":
      return role;
    default:
      return "system";
  }
}

export interface ParseSessionInput {
  conversation: ParsedConversation;
  items: ReadonlyArray<ParsedItem>;
  source: SourceLlm;
}

export function parseSessionBlob(input: ParseSessionInput): SessionBlob {
  const { conversation, items, source } = input;
  const fallbackTimestamp = conversation.created_at ?? Math.floor(Date.now() / 1000);

  const messages: Message[] = [];
  for (const item of items) {
    if (item.type !== "message") continue;
    if (typeof item.role !== "string") continue;
    messages.push({
      role: normalizeRole(item.role),
      content: extractText(item.content),
      created_at:
        typeof item.created_at === "number" && Number.isFinite(item.created_at)
          ? Math.floor(item.created_at)
          : fallbackTimestamp,
    });
  }

  const metadata: Record<string, unknown> = {
    upstream_id: conversation.id,
    upstream_source: source,
    upstream_created_at: conversation.created_at,
  };
  if (conversation.metadata !== undefined) {
    metadata.upstream_metadata = conversation.metadata;
  }

  return {
    session_id: conversation.id,
    source_llm: source,
    messages,
    metadata,
  };
}
