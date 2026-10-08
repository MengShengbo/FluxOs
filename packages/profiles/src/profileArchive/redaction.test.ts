import { describe, expect, it } from 'vitest'
import { containsForbiddenExportData, redactExportText, redactExportValue, virtualizeExportPath } from './redaction'

const policy = {
  version: 1 as const,
  workspaces: [{ id: 'workspace-12345678', localPath: '/Users/example/Projects/Demo' }],
  allowSecrets: false,
}

describe('profile archive redaction', () => {
  it('removes JSON credentials and HTTP authentication headers inside tool output text', () => {
    const text = 'result {"apiKey":"short","refresh_token":"refresh-value","safe":"keep"}\nAuthorization: Basic dXNlcjpwYXNz\nCookie: session=private-cookie\nSet-Cookie: auth=private-response'
    expect(containsForbiddenExportData(text)).toBe(true)
    const result = redactExportText(text, policy)
    for (const secret of ['short', 'refresh-value', 'dXNlcjpwYXNz', 'private-cookie', 'private-response']) expect(result).not.toContain(secret)
    expect(result).toContain('"safe":"keep"')
    expect(containsForbiddenExportData(result)).toBe(false)
    expect(redactExportText(text, { ...policy, allowSecrets: true })).toBe(text)
  })

  it('virtualizes known workspace paths and removes unrelated absolute paths', () => {
    expect(virtualizeExportPath('/Users/example/Projects/Demo/src/app.ts', policy.workspaces)).toBe('workspace://workspace-12345678/src/app.ts')
    expect(virtualizeExportPath('/private/tmp/outside.txt', policy.workspaces)).toBe('<local-path-removed>')
    expect(redactExportText('open /Users/example/Projects/Demo/src/app.ts then /private/tmp/secret.txt', policy))
      .toBe('open workspace://workspace-12345678/src/app.ts then <local-path-removed>')
  })

  it('removes secret and device fields recursively without changing safe values', () => {
    const redacted = redactExportValue({
      provider: 'custom',
      apiKey: 'sk-abcdefghijklmnop',
      nested: { authorization: 'Bearer abcdefghijklmnop', installationId: 'device-1', note: 'safe' },
    }, policy)
    expect(redacted).toEqual({ provider: 'custom', apiKey: '', nested: { authorization: '', note: 'safe' } })
    expect(containsForbiddenExportData(JSON.stringify(redacted))).toBe(false)
  })
})
