/**
 * Continuum layered-memory types.
 *
 * Continuum stores the navigable middle layers of long-term memory as
 * user-readable markdown under `<memoryRoot>/continuum/`:
 * - `daily/<date>.md` — one rollup per day with message-level references.
 * - `entities/<slug>.md` — per person/project/topic dossiers with an
 *   append-only timeline.
 *
 * The markdown files are the source of truth (the user owns and may edit
 * them); parsed structures and search indexes are rebuildable caches keyed
 * by file fingerprints.
 */

/** Message-level coordinate plus digest pinning the exact evidence. */
export interface ContinuumReference {
  conversationId: string
  messageId: string
  offset: number
  digest: string
}

export interface ContinuumDailyKeyDetail {
  text: string
  refs: ContinuumReference[]
}

export interface ContinuumDailyEntry {
  conversationId: string
  title: string
  workspaceId: string | null
  summary: string
  keyDetails: ContinuumDailyKeyDetail[]
}

export interface ContinuumCorrection {
  at: number
  note: string
  refs: ContinuumReference[]
}

export interface ContinuumDailyRollup {
  /** ISO date, YYYY-MM-DD. */
  date: string
  generatedAt: number
  workspaces: string[]
  entries: ContinuumDailyEntry[]
  /** Optional model-written day narrative; mechanical assembly leaves this unset. */
  narrative?: string
  corrections: ContinuumCorrection[]
}

export type ContinuumEntityKind = 'person' | 'project' | 'topic'

export interface ContinuumTimelineEvent {
  at: number
  /** ISO date of the event, YYYY-MM-DD. */
  date: string
  text: string
  refs: ContinuumReference[]
}

export interface ContinuumEntityDossier {
  slug: string
  name: string
  aliases: string[]
  kind: ContinuumEntityKind
  summary: string
  timeline: ContinuumTimelineEvent[]
  linkedMemoryIds: string[]
  updatedAt: number
}

export interface ContinuumEntityIndexRecord {
  slug: string
  name: string
  aliases: string[]
  kind: ContinuumEntityKind
  dirty: boolean
  updatedAt: number
}

export type ContinuumRecallDepth = 'recent' | 'topic' | 'deep' | 'exact'

export interface ContinuumNextRead {
  conversationId: string
  messageId: string
  offset: number
}

export interface ContinuumRecallSection {
  kind: 'rollup' | 'summary' | 'entity' | 'memory' | 'message' | 'hint'
  title: string
  text: string
  refs: ContinuumReference[]
  nextReads?: ContinuumNextRead[]
}

export interface ContinuumRecallResult {
  depth: ContinuumRecallDepth
  sections: ContinuumRecallSection[]
  truncated: boolean
}

export interface ContinuumStatus {
  enabled: boolean
  dailyCount: number
  entityCount: number
  dirtyEntities: string[]
  latestDailyDate?: string
  continuumCallsToday: number
  lastCompletedAt?: number
  lastError?: string
}

/** A pending entity synthesis request handed to the host-injected generator. */
export interface ContinuumEntitySynthesisRequest {
  slug: string
  name: string
  kind: ContinuumEntityKind
  /** Transcript chunks to synthesize from, in chronological order. */
  chunks: { text: string; refs: ContinuumReference[] }[]
  currentSummary: string
  timeline: ContinuumTimelineEvent[]
}
