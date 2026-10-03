import { createHash, randomUUID } from 'node:crypto'
import type { AgentTurn } from '@fluxagentcore/contracts/agentTypes'
import type { ChildAgentMessageReceipt } from '@fluxagentcore/contracts/childAgentTypes'

/** Limits are local to one child. Receipts do not retain a second copy of committed text. */
export const CHILD_MAILBOX_LIMITS = {
  maxMessageCharacters: 20_000,
  maxPendingMessages: 32,
  maxPendingBytes: 64_000,
  retainedCommittedReceipts: 128,
} as const

export interface StoredChildMessage extends ChildAgentMessageReceipt {
  contentHash: string
  /** Present only while queued; committed content belongs to the durable transcript. */
  message?: string
}
export interface ChildMessageOptions {
  messageId?: string
  intent?: ChildAgentMessageReceipt['intent']
  sourceWorkRunId?: string
}

export function messageReceipt(message: StoredChildMessage): ChildAgentMessageReceipt {
  const { contentHash: _hash, message: _text, ...receipt } = message
  return { ...receipt }
}

export function enqueueChildMessage(
  messages: readonly StoredChildMessage[], text: string, options: ChildMessageOptions = {},
): { messages: StoredChildMessage[]; receipt: ChildAgentMessageReceipt; duplicate: boolean } {
  if (!text.trim() || text.length > CHILD_MAILBOX_LIMITS.maxMessageCharacters) {
    throw new Error('Message must contain 1–20000 characters')
  }
  const messageId = options.messageId ?? 'child-message-' + randomUUID()
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(messageId)) throw new Error('message_id must contain 1–128 letters, digits, dots, colons, underscores or hyphens')
  const intent = options.intent ?? 'message'
  const contentHash = createHash('sha256').update(text).digest('hex')
  const previous = messages.find(message => message.messageId === messageId)
  if (previous) {
    if (previous.contentHash !== contentHash || previous.intent !== intent) throw new Error('message_id already identifies a different message')
    return { messages: [...messages], receipt: messageReceipt(previous), duplicate: true }
  }
  const pending = messages.filter(message => message.state === 'queued')
  if (pending.length >= CHILD_MAILBOX_LIMITS.maxPendingMessages) throw new Error('Child message queue is full')
  const bytes = pending.reduce((sum, message) => sum + Buffer.byteLength(message.message || '', 'utf8'), Buffer.byteLength(text, 'utf8'))
  if (bytes > CHILD_MAILBOX_LIMITS.maxPendingBytes) throw new Error('Child message queue exceeds its 64000-byte context budget')
  const message: StoredChildMessage = {
    messageId, intent, state: 'queued', createdAt: Date.now(), contentHash, message: text,
    ...(options.sourceWorkRunId ? { sourceWorkRunId: options.sourceWorkRunId } : {}),
  }
  return { messages: [...messages, message], receipt: messageReceipt(message), duplicate: false }
}

/** Old inboxes may exceed today's admission budget. Drain a bounded prefix without dropping the rest. */
export function childMessageBatch(messages: readonly StoredChildMessage[]): StoredChildMessage[] {
  const batch: StoredChildMessage[] = []
  let bytes = 0
  for (const message of messages) {
    if (message.state !== 'queued') continue
    const size = Buffer.byteLength(message.message || '', 'utf8')
    if (bytes + size > CHILD_MAILBOX_LIMITS.maxPendingBytes || batch.length >= CHILD_MAILBOX_LIMITS.maxPendingMessages) break
    batch.push(message)
    bytes += size
  }
  return batch
}

/** Reconcile from persisted user turns, never from an executor's acceptance notification. */
export function reconcileChildMessages(messages: readonly StoredChildMessage[], turns: readonly AgentTurn[]): StoredChildMessage[] {
  const userTurns = new Map(turns.filter(turn => turn.role === 'user').map(turn => [turn.id, turn]))
  const committed = messages.map(message => {
    const turn = userTurns.get(message.messageId)
    if (message.state !== 'queued' || !turn || turn.content !== message.message?.trim()) return message
    const { message: _text, ...receipt } = message
    return { ...receipt, state: 'committed' as const, committedAt: turn.timestamp, executionId: turn.metadata?.workRunId }
  })
  const receipts = committed.filter(message => message.state === 'committed').slice(-CHILD_MAILBOX_LIMITS.retainedCommittedReceipts)
  const retained = new Set(receipts.map(message => message.messageId))
  return committed.filter(message => message.state === 'queued' || retained.has(message.messageId))
}
