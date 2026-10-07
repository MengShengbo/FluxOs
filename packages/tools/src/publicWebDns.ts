import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { interceptors, type Dispatcher } from 'undici'
import { getPinnedNetworkDispatcher } from '@fluxos/platform/networkProxy'

type Address = { address: string; family: 4 | 6 }
const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blocked.addSubnet(address, prefix, 'ipv6')
}
const globalIpv6 = new BlockList()
globalIpv6.addSubnet('2000::', 3, 'ipv6')
const synthetic = new BlockList()
synthetic.addSubnet('198.18.0.0', 15, 'ipv4')
const BLOCKED_MESSAGE = 'Local, private-network, and reserved addresses cannot be read'

function isPublic(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalIpv6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

function assertPublic(addresses: Address[]): Address[] {
  if (!addresses.length || addresses.some(item => !isPublic(item.address))) throw new Error(BLOCKED_MESSAGE)
  return addresses
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Resolve a proxy's synthetic DNS response via a fixed TLS-authenticated
 * resolver. This never permits connecting to 198.18/15 or arbitrary private
 * targets. Both the resolver bootstrap and the final transport are IP-pinned.
 */
async function resolveSyntheticHostname(hostname: string, parentSignal: AbortSignal): Promise<Address[]> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(5000)])
  const query = new URL('https://cloudflare-dns.com/dns-query')
  query.searchParams.set('name', hostname)
  query.searchParams.set('type', 'A')
  const dispatcher = getPinnedNetworkDispatcher(query).compose(interceptors.dns({
    maxTTL: 5000, maxItems: 1,
    lookup: (origin, _options, callback) => {
      if (origin.hostname !== 'cloudflare-dns.com') return callback(new Error('Invalid DNS resolver target'), [])
      callback(null, [{ address: '1.1.1.1', family: 4, ttl: 5000 }])
    },
  }))
  const response = await withAbort(fetch(query, {
    headers: { Accept: 'application/dns-json' }, redirect: 'error', signal, dispatcher,
  } as RequestInit & { dispatcher: Dispatcher }), signal)
  const reader = response.body?.getReader()
  try {
    if (!response.ok || !reader) throw new Error('Public DNS lookup failed: HTTP ' + response.status)
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const next = await withAbort(reader.read(), signal)
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 16_384) throw new Error('Public DNS response exceeds its size limit')
      chunks.push(next.value)
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      Status?: number; TC?: boolean; Question?: Array<{ name: string; type: number }>
      Answer?: Array<{ name: string; type: number; data: string }>
    }
    const normalize = (value: string) => value.toLowerCase().replace(/\.$/, '')
    if (data.Status !== 0 || data.TC || data.Question?.[0]?.type !== 1 || normalize(data.Question[0].name) !== hostname) {
      throw new Error('Public DNS lookup returned an invalid or unsuccessful answer')
    }
    const answers = data.Answer || []
    const names = new Set([hostname])
    // Only accept address records for the question or its CNAME chain.
    for (let hop = 0; hop < 8; hop++) for (const answer of answers) {
      if (answer.type === 5 && names.has(normalize(answer.name))) names.add(normalize(answer.data))
    }
    return assertPublic(answers.filter(answer => answer.type === 1 && names.has(normalize(answer.name)))
      .map(answer => ({ address: answer.data, family: 4 as const })))
  } finally {
    if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  }
}

export async function resolvePublicWebAddresses(hostname: string, signal: AbortSignal): Promise<Address[]> {
  signal.throwIfAborted()
  const family = isIP(hostname)
  if (family) return assertPublic([{ address: hostname, family: family as 4 | 6 }])
  const addresses = (await withAbort(lookup(hostname, { all: true, verbatim: true }), signal)) as Address[]
  // Only an exclusively synthetic answer enables recovery. Mixed or ordinary
  // private answers remain blocked, including each redirected destination.
  if (addresses.length && addresses.every(item => item.family === 4 && synthetic.check(item.address, 'ipv4'))) {
    try { return await resolveSyntheticHostname(hostname, signal) } catch (error) {
      signal.throwIfAborted()
      throw new Error('The local proxy returned synthetic DNS addresses; public DNS validation failed. ' + (error instanceof Error ? error.message : String(error)), { cause: error })
    }
  }
  return assertPublic(addresses)
}
