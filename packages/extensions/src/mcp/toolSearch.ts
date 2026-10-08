import type { McpToolInfo } from './types'

// Deliberately small, inspectable vocabulary. These are lexical aliases, not
// translations of arbitrary intent or a promise that a tool can do the task.
const aliasGroups = [
  ['search', 'find', 'lookup', '搜索', '检索', '查找'],
  ['email', 'emails', 'mail', 'inbox', '邮件', '邮箱', '收件箱'],
  ['calendar', 'calendars', 'agenda', '日历', '日程'],
  ['screenshot', 'screenshots', '截屏', '截图'],
  ['browser', 'webpage', 'webpages', '浏览器', '网页'],
  ['repository', 'repositories', 'repo', 'codebase', '仓库', '代码库'],
  ['issue', 'issues', 'ticket', 'tickets', '工单', '问题单'],
] as const
const aliases = new Map<string, string>(aliasGroups.flatMap(group => group.map(term => [term, group[0]] as const)))
// ICU word segmentation can split domain words such as 工单 or 截屏. Match
// only the explicit Han vocabulary first, longest phrase first.
const hanAliases = new RegExp([...aliases.keys()].filter(term => /\p{Script=Han}/u.test(term)).sort((a, b) => b.length - a.length).join('|'), 'gu')
const stopwords = new Set(['a', 'an', 'the', 'please', 'could', 'would', 'can', 'you', 'my', 'me', 'for', 'to', 'of', 'in', 'on', 'and', 'with', '帮', '帮我', '请', '一下', '一个', '我的', '我', '给'])
const segmenter = new Intl.Segmenter('en', { granularity: 'word' })
function terms(text: string): Set<string> {
  const normalized = text.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').normalize('NFKC').toLowerCase()
    .replace(hanAliases, term => ` ${aliases.get(term)} `)
  return new Set([...segmenter.segment(normalized)]
    .filter(segment => segment.isWordLike && !stopwords.has(segment.segment))
    .map(segment => aliases.get(segment.segment) ?? segment.segment))
}

export function searchMcpTools(tools: readonly McpToolInfo[], query: string, limit = 8): McpToolInfo[] {
  const queryTerms = [...terms(query)]
  if (queryTerms.length === 0) return []
  const cap = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 8
  const documents = tools.map(tool => ({ tool,
    name: terms(`${tool.serverName} ${tool.name}`),
    body: terms(`${tool.description} ${tool.instructions || ''} ${JSON.stringify(tool.inputSchema || {})}`),
  }))
  const weights = new Map(queryTerms.map(term => {
    const frequency = documents.filter(document => document.name.has(term) || document.body.has(term)).length
    return [term, Math.log(1 + (documents.length + 0.5) / (frequency + 0.5))]
  }))
  return documents.map(document => ({ tool: document.tool,
    score: queryTerms.reduce((total, term) => total + (document.name.has(term) ? 3 : document.body.has(term) ? 1 : 0) * weights.get(term)!, 0),
  })).filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0))
    .slice(0, cap).map(entry => entry.tool)
}
