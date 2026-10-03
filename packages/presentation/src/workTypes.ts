import type { ConversationEventWindowSnapshot } from '@fluxagentcore/contracts/conversationEvent'
import type { WorkProjectionSnapshot } from './workProjection'

export interface WorkSessionSnapshot {
  schemaVersion: 1
  window: ConversationEventWindowSnapshot
  projection: WorkProjectionSnapshot
}
