import { existsSync, readFileSync } from 'node:fs'
import type { AgentAttachment, AgentTurn } from '@fluxos/contracts/agentTypes'
import { toolResultExecutionStatus } from '@fluxos/contracts/toolResultData'
import { formatToolResultForModel } from './modelMessages'

const VISION_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_DIRECT_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_REQUEST_IMAGE_BYTES = 3 * 1024 * 1024
const MAX_REQUEST_IMAGES = 3

export function selectVisionAttachmentIds(turns: AgentTurn[]): Set<string> {
  const selected = new Set<string>()
  let totalBytes = 0
  const candidates = turns.flatMap(turn => [
    ...(turn.metadata?.attachments ?? []),
    ...(turn.toolResults ?? []).flatMap(result => result.attachments ?? []),
  ]).filter(attachment => attachment.type === 'image').reverse()
  for (const attachment of candidates) {
    if (selected.size >= MAX_REQUEST_IMAGES) break
    if (!VISION_IMAGE_MIMES.has(attachment.mime) || attachment.size <= 0 || attachment.size > MAX_DIRECT_IMAGE_BYTES) continue
    if (totalBytes + attachment.size > MAX_REQUEST_IMAGE_BYTES) continue
    selected.add(attachment.id)
    totalBytes += attachment.size
  }
  return selected
}

function attachmentToDataUrl(attachment: AgentAttachment, selectedIds: ReadonlySet<string>): string | null {
  if (!selectedIds.has(attachment.id)) return null
  if (!VISION_IMAGE_MIMES.has(attachment.mime)) return null
  if (!existsSync(attachment.path)) return null
  const bytes = readFileSync(attachment.path)
  if (bytes.length > MAX_DIRECT_IMAGE_BYTES) return null
  return `data:${attachment.mime};base64,${bytes.toString('base64')}`
}

function attachmentManifestText(attachments: AgentAttachment[]): string {
  return [
    '<attachments>',
    'Image attachments are attached when vision is supported. File attachments are imported into the active workspace and may be inspected with workspace tools.',
    ...attachments.map((attachment, index) =>
      attachment.type === 'image'
        ? `<image name="[Image #${index + 1}]" mime="${attachment.mime}" filename="${attachment.filename}" size="${attachment.size}" local_path_redacted="true" />`
        : `<file name="[File #${index + 1}]" mime="${attachment.mime}" filename="${attachment.filename}" size="${attachment.size}" workspace_path=${JSON.stringify(attachment.path)} />`
    ),
    '</attachments>',
  ].join('\n')
}

function buildUserContentWithAttachments(
  turn: AgentTurn,
  provider: 'openai' | 'anthropic',
  selectedIds: ReadonlySet<string>,
): Array<Record<string, unknown>> | null {
  const attachments = turn.metadata?.attachments ?? []
  if (attachments.length === 0) return null

  const content: Array<Record<string, unknown>> = []
  const text = [
    turn.content.trim(),
    attachmentManifestText(attachments),
    turn.metadata?.runtimeContext?.trim(),
  ].filter(Boolean).join('\n\n')
  content.push({ type: 'text', text })

  for (const attachment of attachments) {
    const dataUrl = attachmentToDataUrl(attachment, selectedIds)
    if (!dataUrl) {
      content.push({
        type: 'text',
        text: `[Image attachment kept in the conversation but omitted from this model request's visual budget: ${attachment.filename} (${attachment.mime})]`,
      })
      continue
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(';base64,') + ';base64,'.length)
    if (provider === 'anthropic') {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mime,
          data: base64,
        },
      })
    } else {
      content.push({
        type: 'image_url',
        image_url: { url: dataUrl },
      })
    }
  }

  return content
}

function buildToolAttachmentContent(
  output: string,
  attachments: AgentAttachment[],
  provider: 'openai' | 'anthropic',
  selectedIds: ReadonlySet<string>,
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: output }]
  for (const attachment of attachments.filter(candidate => candidate.type === 'image')) {
    const dataUrl = attachmentToDataUrl(attachment, selectedIds)
    if (!dataUrl) {
      content.push({
        type: 'text',
        text: `[Visual evidence kept in the conversation but omitted from this model request's visual budget: ${attachment.filename} (${attachment.mime})]`,
      })
      continue
    }
    if (provider === 'anthropic') {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mime,
          data: dataUrl.slice(dataUrl.indexOf(';base64,') + ';base64,'.length),
        },
      })
    } else {
      content.push({ type: 'image_url', image_url: { url: dataUrl } })
    }
  }
  return content
}

export function turnToModelMessages(
  turn: AgentTurn,
  provider: 'openai' | 'anthropic',
  selectedVisionAttachmentIds: ReadonlySet<string> = new Set(),
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []

  if (turn.role === 'tool_result' && turn.toolResults) {
    const openAiVisualAttachments: AgentAttachment[] = []
    for (const tr of turn.toolResults) {
      const modelOutput = formatToolResultForModel(tr)
      if (provider === 'anthropic') {
        const attachments = tr.attachments?.filter(attachment => attachment.type === 'image') ?? []
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: tr.toolCallId,
            is_error: ['failed', 'cancelled'].includes(toolResultExecutionStatus(tr)),
            content: attachments.length > 0
              ? buildToolAttachmentContent(modelOutput, attachments, provider, selectedVisionAttachmentIds)
              : modelOutput,
          }],
        })
      } else {
        messages.push({
          role: 'tool',
          tool_call_id: tr.toolCallId,
          content: modelOutput,
        })
        openAiVisualAttachments.push(...(tr.attachments ?? []).filter(attachment => attachment.type === 'image'))
      }
    }
    if (provider === 'openai' && openAiVisualAttachments.length > 0) {
      messages.push({
        role: 'user',
        content: buildToolAttachmentContent(
          [
            'Visual evidence returned by a tool is attached below.',
            'Inspect the captured frame before choosing the next action. Coordinates and element references are frame-relative and may become stale after any page, window, or screen change.',
            attachmentManifestText(openAiVisualAttachments),
          ].join('\n'),
          openAiVisualAttachments,
          provider,
          selectedVisionAttachmentIds,
        ),
      })
    }
    return messages
  }

  if (turn.role === 'user') {
    const attachmentContent = buildUserContentWithAttachments(turn, provider, selectedVisionAttachmentIds)
    if (attachmentContent) {
      messages.push({
        role: 'user',
        content: attachmentContent,
      })
      return messages
    }
    messages.push({
      role: 'user',
      content: [turn.content, turn.metadata?.runtimeContext].filter(Boolean).join('\n\n'),
    })
    return messages
  }

  if (turn.role === 'assistant' && turn.toolCalls && turn.toolCalls.length > 0) {
    if (provider === 'anthropic') {
      const content: Array<Record<string, unknown>> = []
      // Replay raw reasoning blocks (with their original signature hashes)
      // before any text/tool_use blocks. Anthropic requires the full
      // unmodified thinking sequence to be passed back across tool-use turns
      // to maintain reasoning continuity. Skip when the assistant turn was
      // produced without provider-native thinking (no rawReasoningPayload).
      const rawReasoning = turn.metadata?.rawReasoningPayload
      if (rawReasoning?.provider === 'anthropic' && Array.isArray(rawReasoning.blocks)) {
        for (const block of rawReasoning.blocks) {
          if (block.type === 'thinking' && (block.thinking || block.signature)) {
            content.push({
              type: 'thinking',
              thinking: block.thinking ?? '',
              ...(block.signature ? { signature: block.signature } : {}),
            })
          } else if (block.type === 'redacted_thinking' && block.data) {
            content.push({ type: 'redacted_thinking', data: block.data })
          }
        }
      }
      if (turn.content) {
        content.push({ type: 'text', text: turn.content })
      }
      for (const tc of turn.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        })
      }
      messages.push({ role: 'assistant', content })
    } else {
      const openaiToolCalls = turn.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }))

      const openaiMsg: Record<string, unknown> = {
        role: 'assistant',
        content: turn.content || '',
        tool_calls: openaiToolCalls,
      }
      // Echo back reasoning_content for OpenAI-compatible providers that
      // require it (e.g. mimo, DeepSeek-R1). Without this the API returns
      // 400 "The reasoning_content in the thinking mode must be passed back".
      const openaiReasoning = turn.metadata?.rawReasoningPayload
      if (openaiReasoning?.provider === 'openai-compatible' && openaiReasoning.reasoningContent) {
        openaiMsg.reasoning_content = openaiReasoning.reasoningContent
      }
      messages.push(openaiMsg)
    }
    return messages
  }

  // For Anthropic assistant turns without tool calls, we still need to replay
  // any raw reasoning blocks (thinking/redacted_thinking) that were produced
  // during the response. Anthropic requires these to be passed back in every
  // subsequent turn when thinking mode was active — not just tool-use turns.
  if (provider === 'anthropic' && turn.role === 'assistant') {
    const rawReasoning = turn.metadata?.rawReasoningPayload
    if (rawReasoning?.provider === 'anthropic' && Array.isArray(rawReasoning.blocks) && rawReasoning.blocks.length > 0) {
      const content: Array<Record<string, unknown>> = []
      for (const block of rawReasoning.blocks) {
        if (block.type === 'thinking' && (block.thinking || block.signature)) {
          content.push({
            type: 'thinking',
            thinking: block.thinking ?? '',
            ...(block.signature ? { signature: block.signature } : {}),
          })
        } else if (block.type === 'redacted_thinking' && block.data) {
          content.push({ type: 'redacted_thinking', data: block.data })
        }
      }
      if (turn.content) {
        content.push({ type: 'text', text: turn.content })
      }
      messages.push({ role: 'assistant', content })
      return messages
    }
  }

  // For OpenAI-compatible assistant turns without tool calls, echo back
  // reasoning_content if present. This covers the common case where the
  // model returns a plain text reply (no tool use) but still produced
  // reasoning that must be passed back in the next request.
  if (provider === 'openai' && turn.role === 'assistant') {
    const openaiReasoning = turn.metadata?.rawReasoningPayload
    if (openaiReasoning?.provider === 'openai-compatible' && openaiReasoning.reasoningContent) {
      messages.push({
        role: 'assistant',
        content: turn.content,
        reasoning_content: openaiReasoning.reasoningContent,
      })
      return messages
    }
  }

  messages.push({
    role: turn.role,
    content: turn.content,
  })

  return messages
}
