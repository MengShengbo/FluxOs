export interface RetrievedResource {
  path: string
  kind: 'file' | 'directory'
  state: 'found' | 'matched' | 'read'
  line?: number
  endLine?: number
  column?: number
  endColumn?: number
  sourceVersion?: string
  preview?: string
  /** Host diagnostic text; render literally, never as executable markup. */
  annotation?: string
  symbolName?: string
  isWriteAccess?: boolean
  diagnostic?: { code: number; category: string; message: string }
  lines?: Array<{ line: number; text: string; matched?: boolean }>
  matchCount?: number
  textTruncated?: boolean
}

/** Execution facts shared by model output, conversation history, and clients. */
export interface RetrievalResult {
  operation: 'search_files' | 'search_content' | 'read_file' | 'list_directory' | 'code_navigation'
  scope: string
  query?: string
  outputMode?: 'content' | 'files' | 'count'
  resources: RetrievedResource[]
  total?: number
  totalIsExact: boolean
  truncated: boolean
  nextOffset?: number
  nextCursor?: string
  snapshot?: import('./toolExecutor').SearchSnapshot
  incompleteReasons?: import('./toolExecutor').SearchIncompleteReason[]
  warning?: string
  navigation?: Omit<import('./codeNavigation').CodeNavigationResult, 'locations'>
  /** Zero-based UTF-8 byte range; endOffset is exclusive. */
  byteRange?: Omit<import('./toolExecutor').FileByteRangeResult, 'content'>
}
