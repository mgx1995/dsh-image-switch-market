/**
 * dsh-image-switch —— Host 半侧
 *
 * 三件事：
 *   1. 起一个独立监听（`lib/server.js`，默认 127.0.0.1:1236），把 `/v1/images/*`
 *      暴露给 profile 里 `img-router` 这个 provider 当上游。DSH 的 web 端口怎么变
 *      都不影响它。
 *   2. 在 DSH 自己的 webServer 上挂 `/api/image-switch/*`，让设置页同源读写状态。
 *   3. 暴露一个 `image_router` 工具：模型也能帮用户切后端、填 key、测连通。
 *
 * 配置与密钥都在 `~/.dsh/image-switch/`（`config.json` / `keys.json`），不碰
 * profile 的 `cordis.patch.yml`。
 *
 * @module dsh-image-switch
 */

import {
  getState,
  getDshDefault,
  pushDshDefault,
  dshModelRows,
  setDshOrigin,
  removeBackend,
  setActive,
  setKey,
  testBackend,
  upsertBackend,
  CONFIG_PATH
} from './lib/engine.js'
import { PORT, startServer, stopServer } from './lib/server.js'

export const name = 'dsh-image-switch'

/** 没有 webServer 也要能起独立监听，所以只 inject 工具注册表。 */
export const inject = ['tools']

/** 设置页用的同源前缀；`lib/client.js` 的 API 常量必须与之一致。 */
export const ROUTE_PREFIX = '/api/image-switch'

const BODY_LIMIT = 256 * 1024

/* ------------------------------------------------------------------ *
 * webServer 那半边
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > BODY_LIMIT) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/* ------------------------------------------------------------------ *
 * 把后端列表同步进 profile 里 img-router 的模型行
 *
 * DSH「模型」页的生图模型列表只认 provider 配置行（`inputImageGen: true`），
 * 插件自己的 config.json 对那边是不可见的。不写这一步，就会出现「面板加了
 * 后端、模型页看不到」和「面板删了后端、模型页还留着」。
 *
 * 写入只能走 configEditor.edit()：它会在文件锁里改 profile patch、校验 schema、
 * 再让 Loader 热重载。直接改 YAML 或 EntryTree.write() 都会把整棵配置树烘进根文件。
 * ------------------------------------------------------------------ */

const PROVIDER_ENTRY_ID = 'llm-pi-ai'

function findProviderEntry(editor) {
  let rows = []
  try {
    rows = typeof editor?.entries === 'function' ? editor.entries() : []
  } catch {
    rows = []
  }
  return rows.find((row) => row?.options?.id === PROVIDER_ENTRY_ID) ?? null
}

function modelIds(rows) {
  return Array.isArray(rows) ? rows.map((row) => (row && typeof row === 'object' ? row.id : undefined)) : []
}

function makeModelSync(ctx, log) {
  return async function syncDshModels() {
    const editor = ctx.get?.('configEditor')
    if (editor === undefined || typeof editor.edit !== 'function') {
      return { ok: false, skipped: true, error: '这个 profile 没有 configEditor，模型行没有同步（后端本身已保存）' }
    }

    const wanted = dshModelRows()
    if (wanted.length === 0) return { ok: true, added: [], removed: [] }
    const routeName = wanted[0].routeName

    const entry = findProviderEntry(editor)
    if (entry === null) {
      return { ok: false, error: `profile 里找不到 ${PROVIDER_ENTRY_ID} 这一行，模型行没有同步` }
    }

    const added = []
    const removed = []

    // configEditor.edit 内部用 2s 文件锁，宿主同时在写 profile（热重载、别的插件存配置）
    // 时会超时；重试几次比把失败直接甩给用户好。
    const attempt = async (run) => {
      let lastError = null
      for (let i = 0; i < 4; i += 1) {
        try {
          return await run()
        } catch (error) {
          lastError = error
          const message = error instanceof Error ? error.message : String(error)
          if (!/timed out waiting for the writer lock/i.test(message)) throw error
          await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)))
        }
      }
      throw lastError
    }

    try {
      await attempt(() => editor.edit(entry, (current) => {
        // 重试会重跑 change，先清空上一次累加的结果
        added.length = 0
        removed.length = 0
        const next = { ...(current ?? {}) }
        const providers = { ...(next.providers ?? {}) }
        const provider = { ...(providers[routeName] ?? {}) }

        provider.displayName = provider.displayName ?? '生图路由（豆包 / 本地 / 聚合 可切换）'
        provider.api = provider.api ?? 'openai-completions'
        provider.baseURL = provider.baseURL ?? `http://127.0.0.1:${PORT}/v1`
        provider.headers = provider.headers ?? { Authorization: 'Bearer image-shim' }

        const before = Array.isArray(provider.models) ? provider.models : []
        const wantedIds = wanted.map((item) => item.name)
        for (const id of modelIds(before)) {
          if (typeof id === 'string' && !wantedIds.includes(id)) removed.push(id)
        }
        const beforeIds = modelIds(before)
        for (const id of wantedIds) if (!beforeIds.includes(id)) added.push(id)

        // 保留用户手动加在 img-router 下、但不带 inputImageGen 的普通模型行
        const keep = before.filter(
          (row) => !(row && typeof row === 'object' && row.inputImageGen === true)
        )
        provider.models = [...wanted.map((item) => item.row), ...keep]

        providers[routeName] = provider
        next.providers = providers
        return next
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`模型行同步失败：${message}`)
      return { ok: false, error: message, added, removed }
    }

    if (added.length > 0 || removed.length > 0) {
      log(`模型行已同步：+[${added.join(', ')}] -[${removed.join(', ')}]`)
    }
    return { ok: true, added, removed }
  }
}

/**
 * 路由表。
 *
 * 每个动作只写一次：设置页走 HTTP，agent 工具走同一批函数，行为不会分叉。
 */
function buildActions(syncDshModels) {
  return {
    'GET /state': async () => getState(),
    'POST /default': async (body) => {
      const result = await setActive(body.backend)
      return { ...getState(), dsh: result.dsh }
    },
    'POST /key': async (body) => {
      setKey(body.backend, body.key)
      return getState()
    },
    'POST /test': async (body) => testBackend(body.backend),
    'POST /backend': async (body) => {
      const state = upsertBackend(body.name, body.spec ?? {})
      const models = await syncDshModels()
      return { ...state, models }
    },
    'POST /remove': async (body) => {
      const state = removeBackend(body.backend)
      const models = await syncDshModels()
      return { ...state, models }
    },
    'POST /sync': async () => ({ ...getState(), models: await syncDshModels(), dsh: await getDshDefault() })
  }
}

function installSettingsRoutes(ctx, log, actions) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['webServer'], (scoped) => {
    // 顺手把真实 origin 交给 engine：端口每次都变，猜不如问
    try {
      const origin = scoped.webServer.getOrigin?.()
      if (typeof origin === 'string' && origin.length > 0) setDshOrigin(origin)
    } catch {
      /* listen 之前会抛，路由注册完再拿一次 */
    }
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          // 内核做身份认证：不声明 auth 就等于 required，写出来才是意图
          auth: 'required',
          handler: async (req, res) => {
            try {
              const url = new URL(req.url, 'http://127.0.0.1')
              const suffix = url.pathname.slice(ROUTE_PREFIX.length) || '/'
              const key = `${req.method} ${suffix}`
              const action = actions[key]
              if (!action) {
                sendJson(res, 404, { ok: false, error: `没有这个接口：${key}` })
                return
              }
              const body = req.method === 'POST' ? await readJson(req) : {}
              const result = await action(body)
              sendJson(res, 200, { ok: true, data: result })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              log(`接口出错：${message}`)
              sendJson(res, 400, { ok: false, error: message })
            }
          }
        }),
      'image-switch: settings routes'
    )
  })
}

/* ------------------------------------------------------------------ *
 * agent 工具
 * ------------------------------------------------------------------ */

function toolDefinition(log, syncDshModels) {
  return {
    name: 'image_router',
    description:
      '管理生图后端路由：查看后端列表、切换默认后端、填写某个后端的 API key、测试连通性、增删后端。' +
      '生成图片请用 generate_image（默认会走这里选中的后端）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'use', 'set_key', 'test', 'add', 'remove', 'sync'],
          description:
            'list=列出全部后端（含是否已配密钥）；use=把某个设为默认；set_key=写入密钥；test=真跑一张测连通；add=新增或修改后端；remove=删除后端；sync=把后端列表同步成 DSH 模型页的生图模型行。'
        },
        backend: {
          type: 'string',
          description: '后端名，如 local、doubao、autodl、supooo。list/test 之外必填。'
        },
        key: {
          type: 'string',
          description: 'action=set_key 时的 API key；留空字符串表示清除。'
        },
        spec: {
          type: 'object',
          description:
            'action=add 时的后端定义：{ label, kind: "openai"|"ark", baseURL, model, apiKeyEnv, authPrefix, stripQuality, watermark }。'
        }
      },
      required: ['action']
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          data: { type: 'object' },
          error: { type: 'string' }
        }
      },
      render: (value) => {
        if (!value || typeof value !== 'object') return String(value)
        if (value.ok === false) return `image_router 失败：${value.error ?? '未知错误'}`
        return JSON.stringify(value.data ?? value, null, 2)
      }
    },
    async execute(args) {
      const action = String(args?.action ?? 'list')
      try {
        switch (action) {
          case 'list':
            return { ok: true, data: getState() }
          case 'use': {
            const result = await setActive(args.backend)
            return { ok: true, data: { ...getState(), dsh: result.dsh } }
          }
          case 'set_key':
            setKey(args.backend, args.key ?? '')
            return { ok: true, data: getState() }
          case 'test':
            return { ok: true, data: await testBackend(args.backend) }
          case 'add': {
            const state = upsertBackend(args.backend, args.spec ?? {})
            return { ok: true, data: { ...state, models: await syncDshModels() } }
          }
          case 'remove': {
            const state = removeBackend(args.backend)
            return { ok: true, data: { ...state, models: await syncDshModels() } }
          }
          case 'sync':
            return { ok: true, data: { ...getState(), models: await syncDshModels(), dsh: await getDshDefault() } }
          default:
            return { ok: false, error: `不认识的 action：${action}` }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`工具调用失败：${message}`)
        return { ok: false, error: message }
      }
    }
  }
}

function installTool(ctx, log, syncDshModels) {
  try {
    if (typeof ctx?.tools?.register !== 'function') return
    ctx.effect(() => ctx.tools.register(toolDefinition(log, syncDshModels)), 'image-switch: tool')
  } catch (error) {
    log(`工具注册失败：${error?.message ?? error}`)
  }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const log = (message) => {
    try {
      ctx?.logger?.info?.(`[dsh-image-switch] ${message}`)
    } catch {
      /* 记不住就算了 */
    }
  }

  startServer()
  log(`独立生图端点已就绪 http://127.0.0.1:${PORT}/v1，状态文件 ${CONFIG_PATH}`)

  try {
    ctx.effect(() => () => stopServer(), 'image-switch: listener')
  } catch {
    /* 老宿主没有 effect 也行，进程退出会带走监听 */
  }

  const syncDshModels = makeModelSync(ctx, log)
  const actions = buildActions(syncDshModels)

  installSettingsRoutes(ctx, log, actions)
  installTool(ctx, log, syncDshModels)

  // 启动时补一次：用户可能手改过 config.json，或刚从旧包迁移过来。
  // 顺便再问一次 webServer 的真实地址（listen 之前 getOrigin() 会抛，那时拿不到）。
  setTimeout(() => {
    try {
      const server = ctx.get?.('webServer')
      const origin = server?.getOrigin?.()
      if (typeof origin === 'string' && origin.length > 0) setDshOrigin(origin)
    } catch {
      /* 还是拿不到就靠端口探测兜底 */
    }
    syncDshModels().catch((error) => {
      log(`启动同步模型行失败：${error?.message ?? error}`)
    })
  }, 1500)
}
