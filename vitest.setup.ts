import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const previousConversationsDirectory = process.env.FLUXAGENT_CONVERSATIONS_DIR
const testConversationsDirectory = mkdtempSync(join(tmpdir(), 'fluxagent-test-conversations-'))

process.env.FLUXAGENT_CONVERSATIONS_DIR = testConversationsDirectory

afterAll(() => {
  if (previousConversationsDirectory === undefined) delete process.env.FLUXAGENT_CONVERSATIONS_DIR
  else process.env.FLUXAGENT_CONVERSATIONS_DIR = previousConversationsDirectory
  rmSync(testConversationsDirectory, { recursive: true, force: true })
})
