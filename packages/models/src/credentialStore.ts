import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { quarantineCorruptFileSync, writeFileAtomicSync } from '@fluxos/platform/fileIO'
import { getActiveProfilePaths } from '@fluxos/platform/profilePaths'

export interface CredentialSnapshot {
  apiKey?: string
  apiConfigs?: Record<string, string>
}

export interface CredentialProtection {
  protect(plaintext: Buffer): Buffer
  unprotect(ciphertext: Buffer): Buffer
}

let credentialProtection: CredentialProtection | undefined

function credentialsFile(): string {
  return join(getActiveProfilePaths().configRoot, 'credentials.json')
}

export function setCredentialProtection(protection: CredentialProtection | undefined): void {
  credentialProtection = protection
}

function parseSnapshot(raw: Record<string, unknown>): CredentialSnapshot {
  const apiConfigs = raw.apiConfigs && typeof raw.apiConfigs === 'object' && !Array.isArray(raw.apiConfigs)
    ? Object.fromEntries(Object.entries(raw.apiConfigs as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1])))
    : undefined
  return {
    apiKey: typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : undefined,
    apiConfigs,
  }
}

export function loadCredentialSnapshot(): CredentialSnapshot {
  if (!existsSync(credentialsFile())) return {}
  let raw: Record<string, unknown>
  try {
    const parsed = JSON.parse(readFileSync(credentialsFile(), 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Credentials must be a JSON object')
    raw = parsed as Record<string, unknown>
  } catch (error) {
    const backupPath = quarantineCorruptFileSync(credentialsFile())
    console.warn(`FluxOs preserved an invalid credentials file at ${backupPath}: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
  if (raw.schemaVersion !== 2 || typeof raw.payload !== 'string' || typeof raw.protected !== 'boolean') throw new Error('Unsupported credential schema')
  try {
    const encoded = Buffer.from(raw.payload, 'base64url')
    if (raw.protected === true) {
      if (!credentialProtection) {
        console.warn('FluxOs credentials are protected but the platform key store is unavailable; keeping the file untouched')
        return {}
      }
      return parseSnapshot(JSON.parse(credentialProtection.unprotect(encoded).toString('utf-8')))
    }
    return parseSnapshot(JSON.parse(encoded.toString('utf-8')))
  } catch (error) {
    if (raw.protected === true) {
      console.warn(`FluxOs could not decrypt protected credentials: ${error instanceof Error ? error.message : String(error)}`)
      return {}
    }
    const backupPath = quarantineCorruptFileSync(credentialsFile())
    console.warn(`FluxOs preserved an invalid credentials file at ${backupPath}: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

export function serializeCredentialSnapshot(snapshot: CredentialSnapshot): string {
  return serializeCredentialSnapshotWithProtection(snapshot, credentialProtection)
}

function serializeCredentialSnapshotWithProtection(
  snapshot: CredentialSnapshot,
  protection: CredentialProtection | undefined,
): string {
  const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf-8')
  try {
    const protectedPayload = protection?.protect(plaintext)
    try {
      const payload = protectedPayload ? protectedPayload.toString('base64url') : plaintext.toString('base64url')
      return JSON.stringify({ schemaVersion: 2, protected: Boolean(protection), payload }, null, 2)
    } finally {
      protectedPayload?.fill(0)
    }
  } finally {
    plaintext.fill(0)
  }
}

export function saveCredentialSnapshot(snapshot: CredentialSnapshot): void {
  writeFileAtomicSync(credentialsFile(), serializeCredentialSnapshot(snapshot), 0o600)
}

export function getCredentialsFile(): string {
  return credentialsFile()
}
