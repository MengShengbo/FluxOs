import { describe, expect, it } from 'vitest'
import { childMessageBatch, enqueueChildMessage, reconcileChildMessages, migrateChildInbox, messageReceipt, type StoredChildMessage } from './childAgentMailbox'

describe('child mailbox protocol', () => {
  it('deduplicates queued and committed messages without storing committed text twice', () => {
    const accepted = enqueueChildMessage([], 'Do the check', { messageId: 'request-1', sourceWorkRunId: 'parent-run' })
    expect(enqueueChildMessage(accepted.messages, 'Do the check', { messageId: 'request-1' })).toMatchObject({ duplicate: true, receipt: accepted.receipt })
    expect(() => enqueueChildMessage(accepted.messages, 'Change the check', { messageId: 'request-1' })).toThrow('different message')
    const committed = reconcileChildMessages(accepted.messages, [{ id: 'request-1', role: 'user', content: 'Do the check', timestamp: 20, metadata: { workRunId: 'execution-2' } }])
    expect(committed[0]).toMatchObject({ state: 'committed', committedAt: 20, executionId: 'execution-2', sourceWorkRunId: 'parent-run' })
    expect(committed[0]).not.toHaveProperty('message')
    expect(messageReceipt(committed[0]!)).not.toHaveProperty('contentHash')
    expect(enqueueChildMessage(committed, 'Do the check', { messageId: 'request-1' }).receipt.state).toBe('committed')
  })

  it('bounds both message count and UTF-8 backlog and lets duplicates through a full queue', () => {
    let queue: StoredChildMessage[] = []
    for (let index = 0; index < 32; index++) queue = enqueueChildMessage(queue, 'x', { messageId: 'message-' + index }).messages
    expect(() => enqueueChildMessage(queue, 'x')).toThrow('full')
    expect(enqueueChildMessage(queue, 'x', { messageId: 'message-0' }).duplicate).toBe(true)
    const large = enqueueChildMessage([], '测'.repeat(20_000)).messages
    expect(() => enqueueChildMessage(large, '测'.repeat(2_000))).toThrow('64000-byte')
    expect(() => enqueueChildMessage([], 'hello', { messageId: '../invalid' })).toThrow('message_id')
  })

  it('does not mistake a colliding turn ID for context delivery of different text', () => {
    const queued = enqueueChildMessage([], 'original', { messageId: 'collision' }).messages
    const reconciled = reconcileChildMessages(queued, [{ id: 'collision', role: 'user', content: 'different', timestamp: 10 }])
    expect(reconciled[0]?.state).toBe('queued')
    expect(reconcileChildMessages(queued, [{ id: 'collision', role: 'assistant', content: 'original', timestamp: 10 }])[0]?.state).toBe('queued')
  })

  it('retains all pending messages but expires old committed deduplication keys', () => {
    let messages = enqueueChildMessage([], 'Keep pending', { messageId: 'pending' }).messages
    for (let index = 0; index < 129; index++) {
      const id = 'done-' + index
      messages = enqueueChildMessage(messages, 'done', { messageId: id }).messages
      messages = reconcileChildMessages(messages, [{ id, role: 'user', content: 'done', timestamp: index }])
    }
    expect(messages).toHaveLength(129)
    expect(messages[0]).toMatchObject({ messageId: 'pending', state: 'queued', message: 'Keep pending' })
    expect(messages.some(message => message.messageId === 'done-0')).toBe(false)
    expect(enqueueChildMessage(messages, 'done', { messageId: 'done-0' }).duplicate).toBe(false)
  })

  it('drains legacy oversized backlogs in FIFO batches without discarding queued messages', () => {
    const messages = migrateChildInbox([1, 2, 3, 4].map(id => ({ id: 'legacy-' + id, message: 'a'.repeat(20_000) })))
    expect(childMessageBatch(messages).map(message => message.messageId)).toEqual(['legacy-1', 'legacy-2', 'legacy-3'])
    expect(messages).toHaveLength(4)
  })

  it('recovers legacy identity without inventing origin or receipt timestamps', () => {
    const messages = migrateChildInbox([{ id: 'legacy-message', message: 'Old guidance' }])
    expect(messages[0]).not.toHaveProperty('createdAt')
    expect(messages[0]).not.toHaveProperty('sourceWorkRunId')
    const committed = reconcileChildMessages(messages, [{ id: 'legacy-message', role: 'user', content: 'Old guidance', timestamp: 10 }])
    expect(committed[0]).toMatchObject({ state: 'committed', committedAt: 10 })
  })
})
