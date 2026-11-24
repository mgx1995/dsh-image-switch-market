/**
 * dsh-image-switch —— 独立监听（OpenAI 兼容 /v1/images/*）
 *
 * 谁在用它：profile 里 `img-router` 这个 provider 的 baseURL 指向这里。
 * dsh-model-think-level 认为它是个 OpenAI 生图端点，于是把
 * `{ model, prompt, n, size, quality }` 原样 POST 过来；本文件把 model
 * 映射到某个后端、把参数翻译成那个后端能吃的形状、把结果统一成 b64_json。
 *
 * 端口默认 1236（`IMAGE_ROUTER_PORT` 可改）。DSH 自己的 web 端口怎么变都不会
 * 影响这里，provider 的 baseURL 永远不用跟着改。
 *
 * @module lib/server
 */

import http from 'node:http'
import {
  edit,
  generate,
  getState,
  loadConfig,
  removeBackend,
  resolveTarget,
  setActive,
  setKey,
  testBackend,
  upsertBackend
} from './engine.js'

const HOST = '127.0.0.1'
export const PORT = Number(process.env.IMAGE_ROUTER_PORT || 1236)

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  })
  res.end(body)
}

async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const raw = await readBody(req, 1024 * 1024)
  const text = raw.toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 手写 multipart 解析（Node 的 FormData 解析器不给字段名之外的元数据，这里够用） */
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '')
  if (!match) return { fields: {}, files: [] }
  const boundary = Buffer.from(`--${(match[1] || match[2]).trim()}`)
  const fields = {}
  const files = []
  let position = buffer.indexOf(boundary)
  while (position !== -1) {
    const start = position + boundary.length
    if (buffer.slice(start, start + 2).toString() === '--') break
    const next = buffer.indexOf(boundary, start)
    if (next === -1) break
    const part = buffer.slice(start, next)
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headers = part.slice(0, headerEnd).toString('utf8')
      const body = part.slice(headerEnd + 4, part.length - 2)
      const nameMatch = /name="([^"]*)"/i.exec(headers)
      const fileMatch = /filename="([^"]*)"/i.exec(headers)
      const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headers)
      const name = nameMatch?.[1] ?? ''
      if (fileMatch) {
        files.push({
          field: name,
          name: fileMatch[1] || 'image.png',
          mime: typeMatch?.[1]?.trim() || 'image/png',
          bytes: body
        })
      } else if (name) {
        fields[name] = body.toString('utf8')
      }
    }
    position = next
  }
  return { fields, files }
}

/* ------------------------------------------------------------------ *
 * 处理
 * ------------------------------------------------------------------ */

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const pathname = url.pathname

  if (req.method === 'GET' && (pathname === '/health' || pathname === '/')) {
    const config = loadConfig()
    sendJson(res, 200, { ok: true, active: config.active, port: PORT, name: 'dsh-image-switch' })
    return
  }

  if (req.method === 'GET' && (pathname === '/state' || pathname === '/v1/state')) {
    sendJson(res, 200, getState())
    return
  }

  if (req.method === 'GET' && pathname === '/v1/models') {
    const state = getState()
    sendJson(res, 200, {
      object: 'list',
      data: state.backends.map((backend) => ({
        id: backend.model,
        object: 'model',
        owned_by: 'dsh-image-switch',
        name: backend.label
      }))
    })
    return
  }

  if (req.method === 'POST' && pathname === '/admin/default') {
    const body = await readJson(req)
    const result = await setActive(body.backend)
    sendJson(res, 200, { ...getState(), dsh: result.dsh })
    return
  }

  if (req.method === 'POST' && pathname === '/admin/key') {
    const body = await readJson(req)
    setKey(body.backend, body.key)
    sendJson(res, 200, getState())
    return
  }

  if (req.method === 'POST' && pathname === '/admin/test') {
    const body = await readJson(req)
    sendJson(res, 200, await testBackend(body.backend))
    return
  }

  if (req.method === 'POST' && pathname === '/admin/backend') {
    const body = await readJson(req)
    sendJson(res, 200, upsertBackend(body.name, body.spec ?? {}))
    return
  }

  if (req.method === 'POST' && pathname === '/admin/remove') {
    const body = await readJson(req)
    sendJson(res, 200, removeBackend(body.backend))
    return
  }

  if (req.method === 'POST' && pathname === '/v1/images/generations') {
    const body = await readJson(req)
    const config = loadConfig()
    const target = resolveTarget(config, body.model)
    if (!target) {
      sendJson(res, 400, {
        error: {
          message: `未知生图模型：${body.model ?? '(空)'}`,
          type: 'invalid_request_error'
        }
      })
      return
    }
    try {
      const result = await generate(target.name, target.backend, {
        prompt: body.prompt,
        size: body.size,
        n: body.n,
        quality: body.quality
      })
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, error?.status && error.status >= 400 ? error.status : 502, {
        error: { message: error instanceof Error ? error.message : String(error), type: 'image_router_error' }
      })
    }
    return
  }

  if (req.method === 'POST' && pathname === '/v1/images/edits') {
    const raw = await readBody(req)
    const { fields, files } = parseMultipart(raw, req.headers['content-type'])
    const config = loadConfig()
    const target = resolveTarget(config, fields.model)
    if (!target) {
      sendJson(res, 400, { error: { message: `未知生图模型：${fields.model}`, type: 'invalid_request_error' } })
      return
    }
    try {
      const result = await edit(target.name, target.backend, {
        prompt: fields.prompt ?? '',
        size: fields.size || '1024x1024',
        n: Number(fields.n ?? 1),
        files
      })
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, error?.status && error.status >= 400 ? error.status : 502, {
        error: { message: error instanceof Error ? error.message : String(error), type: 'image_router_error' }
      })
    }
    return
  }

  sendJson(res, 404, { error: { message: `没有这个路由：${req.method} ${pathname}` } })
}

/* ------------------------------------------------------------------ *
 * 起服务
 * ------------------------------------------------------------------ */

/**
 * server 句柄挂在 globalThis 上，不放在模块作用域里。
 *
 * 原因：DSH 会热重载插件模块。如果句柄是模块局部变量，重载后新模块看到
 * `server === undefined` 就去 listen，撞上旧代码仍占着的端口 → EADDRINUSE
 * → 新 handler 永远不生效，改代码「看起来没反应」。挂到 globalThis 上，
 * 新模块能拿到旧句柄：先关掉它，再用新 handler 重新监听。
 */
const SLOT = Symbol.for('dsh-image-switch.server')

function retire(previous) {
  return new Promise((resolve) => {
    if (!previous) {
      resolve()
      return
    }
    try {
      previous.close(() => resolve())
      // 已经关掉/从未监听的情况 close 会抛，兜住
    } catch {
      resolve()
    }
  })
}

export function startServer() {
  const previous = globalThis[SLOT]
  if (previous && previous.__dshImageRouter === true) {
    // 同一个包重复 apply：先退役旧的，再起新的，保证 handler 是最新代码
    globalThis[SLOT] = undefined
    void retire(previous).then(() => listen())
    return globalThis[SLOT]
  }
  return listen()
}

function listen() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      try {
        sendJson(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } })
      } catch {
        /* 头已发出就算了 */
      }
    })
  })
  server.__dshImageRouter = true
  server.on('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      console.error(`[dsh-image-switch] 端口 ${PORT} 被占用，独立监听未启动（设置页仍然可用）`)
      return
    }
    console.error('[dsh-image-switch] 监听出错：', error)
  })
  server.listen(PORT, HOST, () => {
    console.log(`[dsh-image-switch] OpenAI 兼容生图端点 http://${HOST}:${PORT}/v1`)
  })
  globalThis[SLOT] = server
  return server
}

export function stopServer() {
  const server = globalThis[SLOT]
  globalThis[SLOT] = undefined
  if (!server) return
  try {
    server.close()
  } catch {
    /* 已经关了 */
  }
}
