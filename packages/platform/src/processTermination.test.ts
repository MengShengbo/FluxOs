import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', () => {
  const execFile = Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: mocks.execute })
  return { execFile }
})
import { createProcessTerminator, terminateOwnedProcess } from './processTermination'

afterEach(() => { vi.restoreAllMocks(); mocks.execute.mockReset() })

it('awaits Windows taskkill /T /F and verifies disappearance instead of fire-and-forget', async () => {
  let release!: (value: unknown) => void
  mocks.execute.mockImplementation(() => new Promise(resolve => { release = resolve }))
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
  let completed = false
  const pending = terminateOwnedProcess(987654, { platform: 'win32' }).then(result => { completed = true; return result })
  await Promise.resolve()
  expect(completed).toBe(false)
  expect(kill).not.toHaveBeenCalled()
  release({ stdout: '', stderr: '' })
  expect(await pending).toMatchObject({ status: 'confirmed', scope: 'windows_taskkill_tree', escalated: true })
  expect(mocks.execute).toHaveBeenCalledWith('taskkill.exe', ['/PID', '987654', '/T', '/F'], expect.objectContaining({ timeout: 3000 }))
})

it('keeps a failed Windows taskkill unknown without falling back to a false tree acknowledgement', async () => {
  mocks.execute.mockRejectedValue(new Error('access denied'))
  const kill = vi.spyOn(process, 'kill')
  expect(await terminateOwnedProcess(987654, { platform: 'win32' })).toMatchObject({ status: 'unknown', error: 'access denied' })
  expect(kill).not.toHaveBeenCalled()
})

it('refuses to signal a root PID whose captured start identity changed', async () => {
  mocks.execute.mockResolvedValue({ stdout: '987654 1 987654 S Wed Oct 7 00:00:02 2026\n', stderr: '' })
  const kill = vi.spyOn(process, 'kill')
  const result = await terminateOwnedProcess(987654, { platform: 'darwin', initial: [
    { pid: 987654, ppid: 1, group: 987654, state: 'S', started: 'Wed Oct 7 00:00:01 2026' },
  ] })
  expect(result).toMatchObject({ status: 'unknown', error: expect.stringContaining('reused PID') })
  expect(kill).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('normalizes ps column padding when the PTY root stops being the last row', async () => {
  const row = '987654 1 987654 S Wed Oct 7 00:00:01 2026'
  mocks.execute.mockResolvedValueOnce({ stdout: row + '    \n', stderr: '' })
    .mockResolvedValueOnce({ stdout: row + '    \n123456 1 123456 S Wed Oct 7 00:00:02 2026    \n', stderr: '' })
    .mockResolvedValue({ stdout: '123456 1 123456 S Wed Oct 7 00:00:02 2026\n', stderr: '' })
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  expect(await createProcessTerminator(987654, () => false)()).toMatchObject({ status: 'confirmed' })
  expect(kill).toHaveBeenCalledWith(-987654, 'SIGTERM')
})
