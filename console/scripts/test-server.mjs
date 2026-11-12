import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const home = mkdtempSync(`${tmpdir()}/rein-console-test-`)
mkdirSync(`${home}/agents`)
mkdirSync(`${home}/native`)
for (const provider of ['pi', 'codex']) {
  mkdirSync(`${home}/${provider}`)
  writeFileSync(
    `${home}/agents/${provider}.json`,
    JSON.stringify({
      name: provider,
      provider,
      enabled: true,
      directory: `${home}/${provider}`,
      native_config: `${home}/native`,
      executable: resolve(root, '../a2alinker/crates/a2alinker/tests/fixtures/fake_agent.py'),
    }),
  )
}
const child = spawn(resolve(root, 'target/debug/reind'), {
  env: { ...process.env, REIND_HOME: home, REIND_HTTP_ADDR: '127.0.0.1:18920' },
  stdio: 'inherit',
})
let stopping = false
function stop() {
  if (!stopping) {
    stopping = true
    child.kill('SIGTERM')
  }
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
child.on('exit', (code) => {
  rmSync(home, { recursive: true, force: true })
  process.exit(code ?? 0)
})
