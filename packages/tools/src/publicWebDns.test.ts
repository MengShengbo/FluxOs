import { lookup } from 'node:dns/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebResearchService } from './webResearchService'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.mocked(lookup).mockReset() })
const response = (address: string, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  Status: 0, Question: [{ name: 'public.test', type: 1 }],
  Answer: [{ name: 'public.test', type: 1, data: address }], ...extra,
}), { status: 200, headers: { 'content-type': 'application/dns-json' } })

describe('synthetic DNS recovery for public webpages', () => {
  it('resolves synthetic addresses independently and reads the page through a pinned dispatcher', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.70', family: 4 }])
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response('93.184.216.34'))
      .mockResolvedValueOnce(new Response('Source text', { headers: { 'content-type': 'text/plain' } }))
    const result = await new WebResearchService().fetchPages({ url: 'https://public.test/article' })
    expect(result).toMatchObject({ success: true, data: { pages: [{ text: 'Source text' }] } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://cloudflare-dns.com/dns-query?name=public.test&type=A')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error', dispatcher: expect.anything() })
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: 'manual', dispatcher: expect.anything() })
    expect(lookup).toHaveBeenCalledOnce()
  })

  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '198.18.0.9', '::1'])('rejects private fallback result %s', async address => {
    vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.70', family: 4 }])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(address))
    const result = await new WebResearchService().fetchPages({ url: 'https://public.test/' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('validation failed')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('never falls back for an ordinary private or mixed DNS answer or a synthetic literal URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    for (const answers of [
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '198.18.0.1', family: 4 }, { address: '93.184.216.34', family: 4 }],
    ]) {
      vi.mocked(lookup).mockResolvedValue(answers)
      expect((await new WebResearchService().fetchPages({ url: 'https://public.test/' })).success).toBe(false)
    }
    expect((await new WebResearchService().fetchPages({ url: 'http://198.18.0.1/' })).success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects mismatched questions, unrelated records and truncated resolver responses', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.70', family: 4 }])
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    for (const extra of [
      { Question: [{ name: 'another.test', type: 1 }] },
      { Answer: [{ name: 'unrelated.test', type: 1, data: '93.184.216.34' }] },
      { TC: true }, { Status: 3 },
    ]) {
      fetchMock.mockResolvedValueOnce(response('93.184.216.34', extra))
      expect((await new WebResearchService().fetchPages({ url: 'https://public.test/' })).success).toBe(false)
    }
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('revalidates redirects after synthetic resolution and does not fetch loopback', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.70', family: 4 }])
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response('93.184.216.34'))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }))
    const result = await new WebResearchService().fetchPages({ url: 'https://public.test/' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('private-network')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('bounds resolver bodies and aborts without a page request', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.70', family: 4 }])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('x'.repeat(17_000)))
    expect((await new WebResearchService().fetchPages({ url: 'https://public.test/' })).error).toContain('size limit')
    let started!: () => void
    const receiving = new Promise<void>(resolve => { started = resolve })
    fetchMock.mockImplementationOnce(async () => { started(); return new Response(new ReadableStream()) })
    const controller = new AbortController()
    const request = new WebResearchService().fetchPages({ url: 'https://public.test/', signal: controller.signal })
    await receiving
    controller.abort(new Error('caller stopped'))
    expect((await request).success).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
