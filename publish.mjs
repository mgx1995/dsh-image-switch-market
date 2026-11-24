#!/usr/bin/env node
/**
 * 发布 dsh-image-switch：校验 → 打包 → （可选）npm publish → 重生成市场索引。
 *
 * 用法：
 *   node publish.mjs                # 只做校验和打包，打印要执行的 npm 命令
 *   node publish.mjs --publish      # 真的 npm publish（需要先 npm login）
 *   node publish.mjs --index-only   # 只重生成 ../dsh-image-switch-market/index.json
 *
 * 没有 npm 账号时，仍可用 --index-only 生成索引，把 index.json 放到任意
 * https 地址，在 Plugins → Discover 里填该地址即可安装。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MARKET_DIR = path.join(HERE, '..', 'dsh-image-switch-market')
const args = new Set(process.argv.slice(2))

function step(title) {
  console.log(`\n=== ${title} ===`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(HERE, file), 'utf8'))
}

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) process.exitCode = 1
  return ok
}

/* ------------------------------------------------------------------ 校验 */

step('1. 清单与规范校验')

const pkg = readJson('package.json')
const en = readJson('locale/en.json')
const zh = readJson('locale/zh.json')

check('package.json name', /^[a-z0-9][a-z0-9._-]*$/.test(pkg.name), pkg.name)
check('未设置 private', pkg.private !== true)
check('version 是 semver', /^\d+\.\d+\.\d+/.test(pkg.version), pkg.version)
check('type = module', pkg.type === 'module')
check('main 指向 index.js', pkg.main === './index.js')
check('dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web')
check('导出 ./client', pkg.exports?.['./client'] === './lib/client.js')
check('导出 ./icon', pkg.exports?.['./icon'] === './icon.svg')
check('导出 ./locale/*.json', Boolean(pkg.exports?.['./locale/*.json']))

for (const key of ['index.js', 'cordis.patch.yml', 'icon.svg', 'docs', 'locale/*.json', 'README.md', 'LICENSE']) {
  check(`files 含 ${key}`, (pkg.files ?? []).includes(key))
}

check('en.json 有 meta.title', Boolean(en.meta?.title))
check('en.json 有 meta.description', Boolean(en.meta?.description))
check('zh.json 有 meta.title', Boolean(zh.meta?.title))
check('zh.json 有 meta.description', Boolean(zh.meta?.description))

for (const [locale, dict] of [['en', en], ['zh', zh]]) {
  const detail = dict.meta?.detail
  if (detail === undefined) continue
  const file = path.join(HERE, detail)
  check(`${locale}.meta.detail 存在`, fs.existsSync(file), detail)
  if (fs.existsSync(file)) {
    const body = fs.readFileSync(file, 'utf8')
    const lines = body.split('\n').filter((line) => line.trim() !== '')
    check(`${locale}.meta.detail 只有一行图片`, lines.length === 1 && /^!\[.+\]\(.+\)$/.test(lines[0].trim()))
    const image = (body.match(/\((https?:[^)]+|[^)]+)\)/) ?? [])[1]
    if (image) check(`${locale} 详情图存在`, fs.existsSync(path.join(path.dirname(file), image)), image)
  }
}

for (const icon of ['icon.svg', 'docs/preview.svg']) {
  // xmlns 里的 http://www.w3.org/2000/svg 是命名空间声明，必须留；只查真正的外链
  const body = fs.readFileSync(path.join(HERE, icon), 'utf8').replace(/xmlns(:\w+)?="http:\/\/www\.w3\.org\/[^"]*"/g, '')
  const forbidden = ['<text', '<style', '<script', 'foreignObject', '<image', 'xlink:href="http', 'http://', 'https://']
  const hit = forbidden.filter((token) => body.includes(token))
  check(`${icon} 自包含`, hit.length === 0, hit.join(', '))
}

const preview = fs.readFileSync(path.join(HERE, 'docs/preview.svg'), 'utf8')
check('preview 是 640×300', /width="640"/.test(preview) && /height="300"/.test(preview))
const icon = fs.readFileSync(path.join(HERE, 'icon.svg'), 'utf8')
check('icon 是 36×36', /width="36"/.test(icon) && /height="36"/.test(icon) && /viewBox="0 0 36 36"/.test(icon))

step('2. 模块语法校验')
for (const file of ['index.js', 'lib/engine.js', 'lib/server.js', 'lib/client.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(HERE, file)], { stdio: 'pipe' })
    check(file, true)
  } catch (error) {
    check(file, false, String(error.stderr ?? error).slice(0, 200))
  }
}

if (args.has('--index-only') || args.has('--publish')) {
  step('3. 重生成市场索引')
  const iconDataUrl = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(HERE, 'icon.svg')).toString('base64')
  const index = {
    format: 1,
    title: { en: 'Local plugins', zh: '本地插件' },
    description: {
      en: 'Plugins built and published from this machine.',
      zh: '在这台机器上构建并发布的插件。'
    },
    // 索引与插件两级的 categories / labels / sortKeys 都是「id 为键的对象」，
    // 不是数组；插件里的 category 必须先在索引这一级声明，否则官方校验器报
    // 「references undeclared id」。
    metadata: {
      categories: {
        image: { title: { en: 'Image', zh: '图片' } }
      },
      labels: {},
      sortKeys: {
        builtin: { title: { en: 'Built-in backends', zh: '内置后端' }, order: 'desc' }
      }
    },
    plugins: [
      {
        name: pkg.name,
        title: { en: en.meta.title, zh: zh.meta.title },
        description: { en: en.meta.description, zh: zh.meta.description },
        icon: iconDataUrl,
        author: 'dsh-image-switch contributors',
        metadata: {
          category: 'image',
          keywords: pkg.keywords,
          labels: [],
          sortKeys: { builtin: 6 }
        },
        versions: [
          {
            version: pkg.version,
            publishTimestamp: Math.floor(Date.now() / 1000),
            source: { type: 'npm', registry: 'https://registry.npmjs.org' },
            engines: pkg.engines
          }
        ]
      }
    ]
  }
  fs.mkdirSync(MARKET_DIR, { recursive: true })
  const target = path.join(MARKET_DIR, 'index.json')
  fs.writeFileSync(target, JSON.stringify(index, null, 2) + '\n', 'utf8')
  console.log(`  写入 ${target}`)
}

if (args.has('--publish')) {
  step('4. npm publish')
  try {
    execFileSync('npm', ['whoami'], { cwd: HERE, stdio: 'pipe' })
  } catch {
    console.error('  尚未登录 npm。先执行 `npm login`（或 `npm config set //registry.npmjs.org/:_authToken=...`）再重跑。')
    process.exit(1)
  }
  const out = execFileSync('npm', ['publish', '--access', 'public'], { cwd: HERE, encoding: 'utf8' })
  console.log(out.trim())
}

if (process.exitCode) {
  console.error('\n校验未通过，先修完再发布。')
} else if (!args.has('--publish')) {
  step('下一步')
  console.log('  包已校验通过。发布二选一：')
  console.log('  A) npm：       npm login && node publish.mjs --publish')
  console.log('  B) 自建索引：  node publish.mjs --index-only')
  console.log('                 把 dsh-image-switch-market/index.json 放到任意 https 地址，')
  console.log('                 在 Plugins → Discover 里填该地址。')
}
