// Single source of truth for Zod schemas and TypeScript types.
import { z } from "zod";

export const SourceLlmSchema = z.enum(["openai", "MiniMax"]);
export type SourceLlm = z.infer<typeof SourceLlmSchema>;

export const MessageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.string(),
  created_at: z.number().int().nonnegative(),
});
export type Message = z.infer<typeof MessageSchema>;

export const SessionBlobSchema = z.object({
  session_id: z.string().min(1),
  source_llm: SourceLlmSchema,
  messages: z.array(MessageSchema),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type SessionBlob = z.infer<typeof SessionBlobSchema>;

export const MergeStrategySchema = z.enum(["concat", "interleave", "summarize"]);
export type MergeStrategy = z.infer<typeof MergeStrategySchema>;

export const CompressorSchema = z.enum(["MiniMax-M3", "openai"]);
export type Compressor = z.infer<typeof CompressorSchema>;

// Tool input schemas (12 MCP tools).

export const ExportSessionInputSchema = z.object({
  source_llm: SourceLlmSchema,
  conversation_id: z.string().min(1),
});
export type ExportSessionInput = z.infer<typeof ExportSessionInputSchema>;

export const ImportSessionInputSchema = z.object({
  blob: SessionBlobSchema,
  external_session_id: z.string().min(1).optional(),
});
export type ImportSessionInput = z.infer<typeof ImportSessionInputSchema>;

export const ListSessionsInputSchema = z.object({
  limit: z.number().int().nonnegative().max(200).default(20),
  offset: z.number().int().nonnegative().default(0),
});
export type ListSessionsInput = z.infer<typeof ListSessionsInputSchema>;

export const GetSessionInputSchema = z.object({
  session_id: z.number().int().positive(),
});
export type GetSessionInput = z.infer<typeof GetSessionInputSchema>;

export const SummarizeProgressInputSchema = z.object({
  session_id: z.number().int().positive(),
  target_tokens: z.number().int().positive().max(32_000).default(4000),
  compressor: CompressorSchema.default("MiniMax-M3"),
});
export type SummarizeProgressInput = z.infer<typeof SummarizeProgressInputSchema>;

export const ExtractOpenQuestionsInputSchema = z.object({
  session_id: z.number().int().positive(),
});
export type ExtractOpenQuestionsInput = z.infer<typeof ExtractOpenQuestionsInputSchema>;

export const ExtractDecisionsInputSchema = z.object({
  session_id: z.number().int().positive(),
});
export type ExtractDecisionsInput = z.infer<typeof ExtractDecisionsInputSchema>;

export const ContinueInInputSchema = z.object({
  source_session_id: z.number().int().positive(),
  target_llm: SourceLlmSchema,
  next_step: z.string().min(1),
  target_tokens: z.number().int().positive().max(32_000).default(4000),
  model: z.string().min(1).optional(),
});
export type ContinueInInput = z.infer<typeof ContinueInInputSchema>;

export const DiffSessionsInputSchema = z.object({
  session_id_a: z.number().int().positive(),
  session_id_b: z.number().int().positive(),
});
export type DiffSessionsInput = z.infer<typeof DiffSessionsInputSchema>;

export const BranchSessionInputSchema = z.object({
  parent_session_id: z.number().int().positive(),
  alternate_path: z.string().min(1),
});
export type BranchSessionInput = z.infer<typeof BranchSessionInputSchema>;

export const MergeSessionsInputSchema = z.object({
  session_ids: z.array(z.number().int().positive()).min(2),
  strategy: MergeStrategySchema,
  target_llm: SourceLlmSchema.default("openai"),
});
export type MergeSessionsInput = z.infer<typeof MergeSessionsInputSchema>;

export const VerifySessionInputSchema = z.object({
  session_id: z.number().int().positive(),
  expected_hash: z.string().optional(),
});
export type VerifySessionInput = z.infer<typeof VerifySessionInputSchema>;
