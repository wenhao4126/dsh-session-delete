import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import plugin from '../index.js'

const PROJECT = 'E:\\fake\\year-end'
const OTHER = 'E:\\fake\\other'

/**
 * 把 Host 半装进一组桩里：shell 只记录命令不真删，persistence 给出
 * 「两个已登记 + 一个同项目子代理 + 一个别的项目」的会话头。
 *
 * `shape` 覆盖 DSH 两代 list() 结构：`flat` 是 0.1.0-rc.6 的扁平 header，
 * `snapshot` 是 0.1.7-rc.2 的 `{ header, revision }` 快照。
 * `shellApi` 覆盖两代 shell 接口：`run` 直接给结果，`execute` 返回需经 `result()` 的句柄。
 */
function harness({ live = new Set(), listThrows = false, shape = 'flat', shellApi = 'run' } = {}) {
  const routes = new Map()
  const removed = []
  const archived = []
  const detached = []
  const workspace = {
    id: 'ws-1',
    path: PROJECT,
    title: 'year-end',
    sessionIds: ['session-a', 'session-b'],
    async detachSession(id) {
      detached.push(id)
    },
  }
  const wrap = (header) => (shape === 'snapshot' ? { header, revision: 'r1' } : header)
  const runResult = () => ({ exitCode: 0, stderr: { text: '' } })
  const shell =
    shellApi === 'execute'
      ? {
          resolve: (request) => request,
          async execute(spec) {
            removed.push(spec.command)
            return { result: async () => runResult() }
          },
        }
      : {
          resolve: (request) => request,
          async run(spec) {
            removed.push(spec.command)
            return runResult()
          },
        }
  const ctx = {
    effect(fn) {
      return fn()
    },
    get: () => undefined,
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => {}
      },
    },
    shell,
    sessionPersistence: {
      async list() {
        if (listThrows) throw new Error('boom')
        return [
          wrap({ id: 'session-a', cwd: PROJECT }),
          wrap({ id: 'session-b', cwd: PROJECT }),
          wrap({ id: 'subagent-1', cwd: PROJECT }),
          wrap({ id: 'elsewhere', cwd: OTHER }),
        ]
      },
      locate: (header) => ({ kind: 'jsonl', path: join('C:\\root', header.cwd, header.id, 'session.v4.jsonl.zstd') }),
    },
    workspaceRegistry: {
      get: (id) => (id === 'ws-1' ? workspace : undefined),
      list: () => [workspace],
      archivedSessionIds: new Set(),
      async archiveSession(id) {
        archived.push(id)
      },
    },
    sessions: { get: (id) => (live.has(id) ? { id } : undefined) },
  }
  plugin.apply(ctx)
  return { routes, removed, archived, detached }
}

async function post(routes, path, body) {
  const req = (async function* () {
    yield Buffer.from(JSON.stringify(body))
  })()
  let status = 0
  let payload = {}
  const res = {
    writeHead(code) {
      status = code
    },
    end(body) {
      payload = JSON.parse(body)
    },
  }
  await routes.get(path)(req, res)
  return { status, payload }
}

// DSH 0.1.7-rc.2 的 list() 返回 { header, revision } 快照，两种结构都必须能删。
for (const shape of ['flat', 'snapshot']) {
  test(`delete-all 覆盖账目之外的同项目会话，且跳过运行中的会话（list 结构=${shape}）`, async () => {
    const { routes, removed, archived, detached } = harness({ live: new Set(['session-b']), shape })
    const { status, payload } = await post(routes, '/dsh-session-delete/delete-all', { workspaceId: 'ws-1' })

    assert.equal(status, 200)
    assert.deepEqual(
      { scanned: payload.scanned, deleted: payload.deleted, live: payload.live, missing: payload.missing },
      { scanned: 3, deleted: 2, live: 1, missing: 0 },
    )
    // 账目里的两个（减去运行中的一个）+ 没登记的子代理会话
    assert.equal(removed.length, 2)
    assert.ok(removed.some((c) => c.includes('subagent-1')), '子代理会话必须进入删除集合')
    assert.ok(!removed.some((c) => c.includes('elsewhere')), '别的项目的会话不得被波及')
    // 运行中的会话既不删文件也不记账
    assert.ok(!removed.some((c) => c.includes('session-b')))
    assert.ok(!archived.includes('session-b') && !detached.includes('session-b'))
  })

  test(`单会话删除同样认得 list 的两种结构（list 结构=${shape}）`, async () => {
    const { routes, removed } = harness({ shape })
    const { status, payload } = await post(routes, '/dsh-session-delete/delete', { sessionId: 'subagent-1' })

    assert.equal(status, 200)
    assert.equal(payload.ok, true)
    assert.equal(removed.length, 1)
    assert.ok(removed[0].includes('subagent-1'))
  })
}

// DSH 0.1.7-rc.2 把 shell 的 run() 改名为 execute()，且结果要经 result() 取。
// 少了这个兼容层，deps.shell.run 不存在 → TypeError → 删除返回 500。
for (const shellApi of ['run', 'execute']) {
  test(`删除在 shell 接口=${shellApi} 下都能跑通（DSH 0.1.7 用 execute+result）`, async () => {
    const { routes, removed } = harness({ shape: 'snapshot', shellApi })
    const { status, payload } = await post(routes, '/dsh-session-delete/delete', { sessionId: 'subagent-1' })

    assert.equal(status, 200)
    assert.equal(payload.ok, true, `shell=${shellApi} 时删除应成功，实际 ${JSON.stringify(payload)}`)
    assert.equal(removed.length, 1)
  })
}

test('persistence.list() 失败时按账目扫描，缺失如实上报', async () => {
  const { routes, removed } = harness({ listThrows: true })
  const { status, payload } = await post(routes, '/dsh-session-delete/delete-all', { workspaceId: 'ws-1' })

  assert.equal(status, 200)
  assert.deepEqual(
    { scanned: payload.scanned, deleted: payload.deleted, missing: payload.missing },
    { scanned: 2, deleted: 0, missing: 2 },
  )
  assert.equal(removed.length, 0)
})
