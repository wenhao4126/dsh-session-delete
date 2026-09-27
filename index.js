/**
 * dsh-session-delete — 工作区侧栏「会话管理：归档 / 恢复 / 删除 / 批量操作」（Host 半）
 *
 * 能力：
 *   - 在 ctx.webServer 注册：
 *       POST /dsh-session-delete/archive
 *       POST /dsh-session-delete/archive-all
 *       POST /dsh-session-delete/delete
 *       POST /dsh-session-delete/delete-all
 *       POST /dsh-session-delete/restore
 *       POST /dsh-session-delete/restore-all
 *       POST /dsh-session-delete/list-archived
 *   - 归档时会额外保存一份“工作区备份”：工作区 id、路径、标题、归档时间；
 *   - 恢复时会优先使用备份里的工作区信息；若工作区注册已删除，则按路径/标题自动重建；
 *   - 删除 = 受限沙箱内移除会话日志目录（workspace-write），成功后才归档隐藏 + 从工作区账目 detach；
 *   - 活跃（本进程内 live）会话拒绝删除，防止误删运行中/已打开会话。
 *
 * 依赖服务（inject）：webServer、shell、sessionPersistence、workspaceRegistry、sessions。
 */
import { realpathSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

const MODULE = '[dsh-session-delete]';

function log(...args) {
  console.error(MODULE, ...args);
}

function textOf(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v.text === 'string') return v.text;
  try {
    return String(v);
  } catch {
    return '';
  }
}

function dirOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? '' : p.slice(0, i);
}

/** POSIX 单引号转义：bash 双引号内特殊字符（$ ` \ !）在此全部保持字面量。 */
function shSingle(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * 按路径分隔符分派删除命令：/-路径走 POSIX bash rm，\-路径走 pwsh
 * Remove-Item（win32 部署组合的是 pwsh 执行器）。
 */
function removalCommand(dir, isWin) {
  if (isWin) {
    const lit = "'" + String(dir).replace(/'/g, "''") + "'";
    return 'Remove-Item -LiteralPath ' + lit + ' -Recurse -Force -ErrorAction Stop';
  }
  return 'rm -rf -- ' + shSingle(dir);
}

/**
 * 跑一条命令并取回前台结果。
 *
 * DSH 0.1.7-rc.2 起 `ctx.shell` 的执行入口由 `run(spec)` 改名为 `execute(spec)`，
 * 且返回的是 `ShellExecution` 句柄——真正的 `ShellRunResult`（`exitCode` /
 * `sandbox.denied` / `stderr`）要再经 `result()` 才能拿到；0.1.0-rc.6 则是
 * `run(spec)` 直接给结果。两种都支持，否则新版上 `deps.shell.run` 不存在，
 * 抛 TypeError 被记成 `run-error`，删除一律返回 500。
 *
 * @param deps - 插件依赖集合（含 `shell`）
 * @param request - `ShellExecRequest`
 * @returns `ShellRunResult` 或旧版等价结果
 */
async function runShell(deps, request) {
  const spec = await deps.shell.resolve(request);
  if (typeof deps.shell.execute === 'function') {
    const execution = await deps.shell.execute(spec);
    return typeof execution?.result === 'function' ? await execution.result() : execution;
  }
  return deps.shell.run(spec);
}

/** 收集并解析 JSON 请求体；空体返回 {}，非法 JSON 返回 null。 */
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 尝试解析为真实路径；目录已不存在时退回原值。 */
function canonicalPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/* ---------------- 工作区备份存储 ---------------- */

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function backupsFile() {
  return join(dshHome(), 'dsh-session-delete-workspace-backups.json');
}

function loadBackups() {
  try {
    const file = backupsFile();
    if (!existsSync(file)) return {};
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) {
    log('load backups failed', e);
    return {};
  }
}

function saveBackups(backups) {
  try {
    const file = backupsFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(backups, null, 2), 'utf8');
  } catch (e) {
    log('save backups failed', e);
  }
}

function backupFor(id) {
  return loadBackups()[String(id)] ?? null;
}

function removeBackup(id) {
  const backups = loadBackups();
  if (backups[String(id)] === undefined) return;
  delete backups[String(id)];
  saveBackups(backups);
}

/* ---------------- 会话/工作区查找 ---------------- */

/**
 * 从 `sessionPersistence.list()` 的一项里取出 Session header。
 *
 * DSH 0.1.7-rc.2 起 `list()` 返回 `SessionPersistenceSnapshot`，即
 * `{ header, revision, eventCount?, sizeBytes? }`，会话 id 与 cwd 都在 `header` 里；
 * 0.1.0-rc.6 及更早返回的是扁平的 header 本身。两种都认，否则在新版 DSH 上
 * 每一个会话都会因 `id` 取不到而落到 missing 分支——删除、归档、恢复全部失效。
 *
 * @param snapshot - `list()` 返回的一项
 * @returns 该项的 header，或 undefined（结构无法识别时）
 */
function headerOf(snapshot) {
  if (snapshot === null || snapshot === undefined) return undefined;
  if (snapshot.header !== null && typeof snapshot.header === 'object') return snapshot.header;
  return typeof snapshot.id === 'string' ? snapshot : undefined;
}

async function findHeader(deps, id) {
  try {
    const snapshots = await deps.persistence.list();
    if (!Array.isArray(snapshots)) return undefined;
    for (const snapshot of snapshots) {
      const header = headerOf(snapshot);
      if (header !== undefined && header.id === id) return header;
    }
    return undefined;
  } catch (e) {
    log('list headers failed', e);
    return undefined;
  }
}

function findWorkspaceForSession(reg, id) {
  try {
    for (const w of reg.list()) {
      if (w.sessionIds.includes(id)) return w;
    }
  } catch {}
  return undefined;
}

function backupWorkspace(deps, id, header) {
  const reg = deps.registry;
  const ws = findWorkspaceForSession(reg, id);
  const backups = loadBackups();
  const cwd = header && typeof header.cwd === 'string' ? header.cwd : undefined;
  const path = ws?.path ?? (cwd || '');
  backups[String(id)] = {
    workspaceId: ws?.id ?? null,
    path,
    title: ws?.title ?? (path ? basename(path) : ''),
    archivedAt: new Date().toISOString(),
  };
  saveBackups(backups);
}

/* ---------------- 删除 ---------------- */

/**
 * 某个工作区应覆盖的全部会话：工作区账目里的，加上日志落在同一项目目录下
 * 但没有登记进任何工作区的会话（子代理会话、被 detach 的会话）。
 * 只走 `w.sessionIds` 会漏掉后者——它们不在侧栏，任何 GUI 删除都碰不到，
 * 而 DSH 持久层没有删除接口，这些日志会一直留在磁盘上。
 */
async function sessionIdsForWorkspace(deps, w) {
  const ids = new Set([...w.sessionIds].map(String));
  const target = canonicalPath(w.path);
  let snapshots;
  try {
    snapshots = await deps.persistence.list();
  } catch (e) {
    log('list headers failed', e);
    snapshots = [];
  }
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const h = headerOf(snapshot);
    if (h === undefined) continue;
    if (typeof h.id !== 'string' || h.id === '' || typeof h.cwd !== 'string' || h.cwd === '') continue;
    if (canonicalPath(h.cwd) === target) ids.add(h.id);
  }
  return [...ids];
}

/**
 * 删除一个会话：live 拒绝 → 定位日志 → 沙箱 rm 目录 → 归档 + detach 簿记。
 * 结果写入 report（deleted/live/missing/failed 四类）。
 */
async function deleteOne(deps, id, report) {
  if (deps.sessions.get(id) !== undefined) {
    report.live.push(id);
    return;
  }
  const header = await findHeader(deps, id);
  if (header === undefined) {
    report.missing.push(id);
    return;
  }
  let loc;
  try {
    loc = deps.persistence.locate(header);
  } catch {
    loc = undefined;
  }
  if (loc === undefined || typeof loc.path !== 'string' || loc.path === '') {
    report.failed.push({ id, code: 'no-location' });
    return;
  }
  const dir = dirOf(loc.path);
  const parent = dirOf(dir);
  if (dir === '' || parent === '') {
    report.failed.push({ id, code: 'bad-path' });
    return;
  }
  /* 1) 先删文件：受限沙箱（root=该项目目录）。失败则无任何状态变化。 */
  let res;
  try {
    res = await runShell(deps, {
      command: removalCommand(dir, loc.path.indexOf('\\') !== -1),
      timeoutMs: 30_000,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: parent },
    });
  } catch (e) {
    report.failed.push({ id, code: 'run-error', detail: textOf(e && e.message) });
    return;
  }
  const denied = res?.sandbox !== undefined && res.sandbox.denied === true;
  if (res?.exitCode !== 0) {
    report.failed.push({ id, code: denied ? 'sandbox-denied' : 'rm-failed', detail: textOf(res?.stderr) });
    return;
  }
  /* 2) 文件已删，做簿记：归档隐藏 + 工作区账目 detach。失败仅影响显示。 */
  try {
    await deps.registry.archiveSession(id);
  } catch {
    /* 已归档或竞态：忽略 */
  }
  try {
    for (const w of deps.registry.list()) {
      if (w.sessionIds.includes(id)) {
        await w.detachSession(id);
        break;
      }
    }
  } catch {
    /* 下次重启自愈 */
  }
  report.deleted.push(id);
}

/* ---------------- 归档 ---------------- */

async function archiveOne(deps, id, report) {
  const archived = new Set([...deps.registry.archivedSessionIds].map(String));
  if (archived.has(String(id))) {
    report.alreadyArchived.push(id);
    return;
  }
  const header = await findHeader(deps, id);
  if (header === undefined) {
    report.missing.push(id);
    return;
  }
  try {
    backupWorkspace(deps, id, header);
    await deps.registry.archiveSession(id);
    report.archived.push(id);
  } catch (e) {
    report.failed.push({ id, code: 'archive-failed', detail: textOf(e && e.message) });
  }
}

/* ---------------- 恢复 ---------------- */

/** 从工作区注册表全局归档集合移除一个会话（官方无公开 unarchive API，直接写 domain state）。 */
async function unarchive(reg, id) {
  const state = reg.state;
  if (!state || !Array.isArray(state.archivedSessionIds)) {
    throw new Error('workspace registry state is unavailable');
  }
  if (!state.archivedSessionIds.some((x) => String(x) === String(id))) return;
  const next = {
    ...state,
    archivedSessionIds: state.archivedSessionIds.filter((x) => String(x) !== String(id)),
  };
  if (typeof reg.global?.set !== 'function') {
    throw new Error('workspace registry global handle is unavailable');
  }
  await reg.global.set(next);
  reg.state = next;
}

/**
 * 恢复一个已归档会话：
 *   - 优先放回原工作区（会话头 cwd 与现存 workspace 路径匹配，或使用归档时备份的工作区信息）；
 *   - 原工作区注册已删除时，按备份路径/标题自动重建，再回退到 cwd；
 *   - 最后从全局归档集合移除，并清理工作区备份。
 */
async function restoreOne(deps, id, report) {
  const reg = deps.registry;
  const archived = new Set([...reg.archivedSessionIds].map(String));
  if (!archived.has(String(id))) {
    report.notArchived.push(id);
    return;
  }

  const header = await findHeader(deps, id);
  if (header === undefined) {
    report.missing.push(id);
    return;
  }

  const cwd = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined;
  if (!cwd && !backupFor(id)?.path) {
    report.failed.push({ id, code: 'no-cwd', detail: 'session header carries no cwd and no workspace backup exists' });
    return;
  }

  const backup = backupFor(id);
  let targetPath = cwd || backup?.path || '';
  if (backup?.path && existsSync(backup.path) && statSync(backup.path).isDirectory()) {
    targetPath = backup.path;
  }

  const resolved = canonicalPath(targetPath);
  let workspace = reg.list().find((w) => w.path === resolved || w.path === targetPath);
  let created = false;
  if (workspace === undefined) {
    try {
      workspace = await reg.create(targetPath, backup?.title || undefined);
      created = true;
    } catch (e) {
      report.failed.push({ id, code: 'workspace-create-failed', detail: textOf(e && e.message) });
      return;
    }
  }

  try {
    await workspace.attachSession(id);
  } catch (e) {
    report.failed.push({ id, code: 'attach-failed', detail: textOf(e && e.message) });
    return;
  }

  try {
    await unarchive(reg, id);
  } catch (e) {
    report.failed.push({ id, code: 'unarchive-failed', detail: textOf(e && e.message) });
    return;
  }

  removeBackup(id);
  report.restored.push({ id, workspaceId: workspace.id, workspacePath: workspace.path, created });
}

async function restoreMany(deps, ids, report) {
  for (const id of ids) {
    await restoreOne(deps, id, report);
  }
}

/* ---------------- 已归档列表 ---------------- */

async function listArchived(deps) {
  const reg = deps.registry;
  const ids = [...reg.archivedSessionIds].map(String);
  const snapshots = await deps.persistence.list();
  const byId = new Map();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const h = headerOf(snapshot);
    if (h !== undefined && typeof h.id === 'string') byId.set(h.id, h);
  }
  const backups = loadBackups();

  let titles = new Map();
  try {
    const sessionQuery = deps.sessionQuery;
    if (sessionQuery && ids.length > 0 && typeof sessionQuery.readTitleSnapshots === 'function') {
      const obs = await sessionQuery.readTitleSnapshots(ids);
      for (const o of Array.isArray(obs) ? obs : []) {
        if (o.status === 'fulfilled' && o.value?.title) {
          titles.set(String(o.sessionId), typeof o.value.title.title === 'string' ? o.value.title.title : undefined);
        }
      }
    }
  } catch (e) {
    log('title lookup failed', e);
  }

  return {
    sessions: ids.map((id) => {
      const h = byId.get(id);
      const backup = backups[id] ?? null;
      const cwd = h?.cwd ?? backup?.path ?? '';
      return {
        id,
        title: titles.get(id) || '',
        cwd,
        workspaceId: backup?.workspaceId ?? null,
        workspacePath: backup?.path ?? '',
        workspaceTitle: backup?.title ?? '',
        archivedAt: backup?.archivedAt ?? '',
        hasBackup: !!backup,
      };
    }),
  };
}

export default {
  name: 'dsh-session-delete',
  inject: ['webServer', 'shell', 'sessionPersistence', 'workspaceRegistry', 'sessions'],
  apply(ctx) {
    const deps = {
      shell: ctx.shell,
      persistence: ctx.sessionPersistence,
      registry: ctx.workspaceRegistry,
      sessions: ctx.sessions,
      sessionQuery: ctx.get('sessionQuery'),
    };

    const routes = [
      {
        path: '/dsh-session-delete/delete',
        handler: async (req, res) => {
          const body = await readJsonBody(req);
          if (body === null || typeof body.sessionId !== 'string' || body.sessionId === '') {
            sendJson(res, 400, { ok: false, code: 'bad-args' });
            return;
          }
          const report = { deleted: [], live: [], missing: [], failed: [] };
          await deleteOne(deps, body.sessionId, report);
          if (report.deleted.length > 0) sendJson(res, 200, { ok: true });
          else if (report.live.length > 0) sendJson(res, 409, { ok: false, code: 'live' });
          else if (report.missing.length > 0) sendJson(res, 404, { ok: false, code: 'missing' });
          else {
            const f = report.failed[0];
            sendJson(res, 500, { ok: false, code: f === undefined ? 'unknown' : f.code, detail: f === undefined ? '' : f.detail });
          }
        },
      },
      {
        path: '/dsh-session-delete/delete-all',
        handler: async (req, res) => {
          const body = await readJsonBody(req);
          if (body === null || typeof body.workspaceId !== 'string' || body.workspaceId === '') {
            sendJson(res, 400, { ok: false, code: 'bad-args' });
            return;
          }
          const w = deps.registry.get(body.workspaceId);
          if (w === undefined) {
            sendJson(res, 404, { ok: false, code: 'unknown-workspace' });
            return;
          }
          const report = { deleted: [], live: [], missing: [], failed: [] };
          const ids = await sessionIdsForWorkspace(deps, w);
          for (const id of ids) await deleteOne(deps, id, report);
          sendJson(res, 200, {
            ok: true,
            scanned: ids.length,
            deleted: report.deleted.length,
            live: report.live.length,
            missing: report.missing.length,
            failed: report.failed,
          });
        },
      },
      {
        path: '/dsh-session-delete/archive',
        handler: async (req, res) => {
          const body = await readJsonBody(req);
          if (body === null || typeof body.sessionId !== 'string' || body.sessionId === '') {
            sendJson(res, 400, { ok: false, code: 'bad-args' });
            return;
          }
          const report = { archived: [], alreadyArchived: [], missing: [], failed: [] };
          await archiveOne(deps, body.sessionId, report);
          if (report.archived.length > 0) sendJson(res, 200, { ok: true });
          else if (report.alreadyArchived.length > 0) sendJson(res, 200, { ok: false, code: 'already-archived' });
          else if (report.missing.length > 0) sendJson(res, 404, { ok: false, code: 'missing' });
          else {
            const f = report.failed[0];
            sendJson(res, 500, { ok: false, code: f === undefined ? 'unknown' : f.code, detail: f === undefined ? '' : f.detail });
          }
        },
      },
      {
        path: '/dsh-session-delete/archive-all',
        handler: async (req, res) => {
          const body = await readJsonBody(req);
          if (body === null || typeof body.workspaceId !== 'string' || body.workspaceId === '') {
            sendJson(res, 400, { ok: false, code: 'bad-args' });
            return;
          }
          const w = deps.registry.get(body.workspaceId);
          if (w === undefined) {
            sendJson(res, 404, { ok: false, code: 'unknown-workspace' });
            return;
          }
          const archivedSet = new Set(deps.registry.archivedSessionIds);
          const report = { archived: [], alreadyArchived: [], missing: [], failed: [] };
          for (const id of [...w.sessionIds]) {
            if (archivedSet.has(id)) continue;
            await archiveOne(deps, id, report);
          }
          sendJson(res, 200, { ok: true, archived: report.archived.length, failed: report.failed });
        },
      },
      {
        path: '/dsh-session-delete/restore',
        handler: async (req, res) => {
          const body = await readJsonBody(req);
          if (body === null || typeof body.sessionId !== 'string' || body.sessionId === '') {
            sendJson(res, 400, { ok: false, code: 'bad-args' });
            return;
          }
          const report = { restored: [], notArchived: [], missing: [], failed: [] };
          await restoreOne(deps, body.sessionId, report);
          if (report.restored.length > 0) {
            sendJson(res, 200, { ok: true, restored: report.restored[0] });
          } else if (report.notArchived.length > 0) {
            sendJson(res, 200, { ok: false, code: 'not-archived' });
          } else if (report.missing.length > 0) {
            sendJson(res, 404, { ok: false, code: 'missing' });
          } else {
            const f = report.failed[0];
            sendJson(res, 500, { ok: false, code: f === undefined ? 'unknown' : f.code, detail: f === undefined ? '' : f.detail });
          }
        },
      },
      {
        path: '/dsh-session-delete/restore-all',
        handler: async (req, res) => {
          const body = await readJsonBody(req);
          const report = { restored: [], notArchived: [], missing: [], failed: [] };
          const archivedSet = new Set([...deps.registry.archivedSessionIds].map(String));

          let ids = [];
          if (body !== null && typeof body.workspaceId === 'string' && body.workspaceId !== '') {
            const w = deps.registry.get(body.workspaceId);
            if (w === undefined) {
              sendJson(res, 404, { ok: false, code: 'unknown-workspace' });
              return;
            }
            ids = [...w.sessionIds].filter((id) => archivedSet.has(String(id)));
          } else {
            ids = [...deps.registry.archivedSessionIds];
          }

          await restoreMany(deps, ids, report);
          sendJson(res, 200, {
            ok: true,
            restored: report.restored.length,
            notArchived: report.notArchived.length,
            missing: report.missing.length,
            failed: report.failed,
            details: report.restored,
          });
        },
      },
      {
        path: '/dsh-session-delete/list-archived',
        handler: async (req, res) => {
          const data = await listArchived(deps);
          sendJson(res, 200, { ok: true, ...data });
        },
      },
    ];

    for (const r of routes) {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: r.path, handler: r.handler }));
    }
    log('host ready: POST /dsh-session-delete/{archive,archive-all,delete,delete-all,restore,restore-all,list-archived}');
  },
};
