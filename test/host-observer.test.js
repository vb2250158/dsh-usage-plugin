import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('host observers freeze prices for streams and search events without masking upstream errors', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-usage-observer-'))
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../test-support/host-observer.mjs', import.meta.url)), root], {
    cwd: root, timeout: 25000, windowsHide: true,
    env: { ...process.env, USERPROFILE: path.join(root, 'home'), LOCALAPPDATA: path.join(root, 'Local'), APPDATA: path.join(root, 'Roaming'), DSH_USAGE_DATA_DIR: path.join(root, 'data') },
  })
  assert.deepEqual(JSON.parse(stdout), { streamedChunks: 2, recordedCalls: 3, upstreamErrorPreserved: true })
})
