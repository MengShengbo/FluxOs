export interface CodeNavigationRequest {
  operation: 'definition' | 'references' | 'diagnostics'
  path: string
  /** One-based lines and UTF-16 columns. */
  line?: number
  column?: number
  projectPath?: string
  sourceVersion?: string
  projectVersion?: string
  offset?: number
  limit?: number
  signal?: AbortSignal
}

export interface CodeLocation {
  path: string
  line: number
  column: number
  endLine: number
  /** Exclusive, one-based UTF-16 column. */
  endColumn: number
  sourceVersion: string
  preview: string
  name?: string
  code?: number
  category?: 'error' | 'warning' | 'suggestion' | 'message'
  message?: string
  isWriteAccess?: boolean
}

export interface CodeNavigationResult {
  operation: CodeNavigationRequest['operation']
  status: 'semantic' | 'unsupported'
  language: 'typescript' | 'javascript' | 'unsupported'
  path: string
  locations: CodeLocation[]
  workspaceRoot: string
  compilerVersion?: string
  projectPath?: string
  inferredProject: boolean
  sourceVersion?: string
  projectVersion?: string
  capturedAt: string
  filesAnalyzed: number
  total: number
  totalIsExact: boolean
  truncated: boolean
  nextOffset?: number
  issues: string[]
  warning: string
  fallback?: { tool: 'search_content'; path: string; semantic: false }
}
