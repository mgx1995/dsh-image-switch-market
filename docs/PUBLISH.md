# 发布记录

`dsh-image-switch@1.0.0`，14 个文件，28.0 kB tarball（unpacked 94.7 kB），shasum `dddef39c6a8ef557c0ef18ba7f76d96a0fce70f3`。

## 一、发布的规则依据

DSH 官方插件分发有两条互相独立的通道，都不需要把包发到官方 npm 作用域（`@deepseek-ai/*` 只留给官方自己用）：

| 通道 | 需要的凭证 | 结果 |
| --- | --- | --- |
| A. npm registry | npm 账号 token | 本机没有：`npm whoami` → `ENEEDAUTH`，无 `~/.npmrc`，无 `NPM_TOKEN` |
| B. format-1 索引 JSON | 任意 https 静态托管 | 已做到，索引通过官方解析器校验 |

索引格式的权威定义在 `@deepseek-ai/dsh-plugin-market-index`，`parseMarketIndex(value, indexUrl)` 是会真正跑在校验路径上的那个函数，本包的索引已用它对过（PASS）。

## 二、索引里踩过的两个坑

1. **`xmlns` 不是外链。** 早期校验把 `xmlns="http://www.w3.org/2000/svg"` 里的 `http://` 当成远程引用判死。SVG 的命名空间声明是必需内容，检查前必须先剥掉：
   ```js
   body.replace(/xmlns(:\w+)?="http:\/\/www\.w3\.org\/[^"]*"/g, '')
   ```
2. **`categories` / `labels` / `sortKeys` 是「id 为键的对象」，不是数组。** 写成 `[{key:'image',...}]` 会被拒：
   ```
   MarketIndexError $.metadata.categories must be an object
   ```
   正确形状：
   ```json
   "metadata": {
     "categories": { "image": { "title": { "en": "Image", "zh": "图片" } } },
     "labels": {},
     "sortKeys": { "builtin": { "title": { "en": "Built-in backends", "zh": "内置后端" }, "order": "desc" } }
   }
   ```
   并且插件里写的 `metadata.category: "image"` 必须先在索引这一级声明过，否则报 `references undeclared id "image"`。

## 三、发布包内容

```
package.json          name dsh-image-switch / 1.0.0 / 无 private
index.js              Host 半：webServer 前缀路由 + image_router 工具
cordis.patch.yml      - insert: [{ id: dsh-image-switch, name: dsh-image-switch }]
lib/engine.js         唯一一套后端逻辑（生成/编辑/密钥/默认同步/JPEG→PNG）
lib/server.js         独立端口 1236 的 OpenAI 兼容面
lib/client.js         设置页（settings.section，order 26）
locale/en.json        meta.title / meta.description / meta.detail
locale/zh.json        同上中文
docs/DETAIL.md        meta.detail 指向，正文只有一行图片
docs/DETAIL.zh.md
docs/preview.svg      640×300 详情图
icon.svg              36×36 图标
README.md
LICENSE               MIT
```

规范核对项（`node publish.mjs` 全部 ok）：包名 / 无 private / semver / `type: module` / `main` / `dsh.bundle.patch` / `dsh.client` / `exports` 七项 / `files` 覆盖 lib、patch、locale、docs、icon / locale 带 meta / detail 单行图片且图存在 / SVG 自包含 / 详情图 640×300 / 图标 36×36 / 四个模块语法。

## 四、怎么发

### 现在就能装（本地索引）

```bash
cd D:/Personal/Downloads/yingyong/dsh-image-switch
node publish.mjs --index-only        # 重生成 ../dsh-image-switch-market/index.json
```

索引和 tarball 都在 `D:\Personal\Downloads\yingyong\dsh-image-switch-market\`。把整个目录放到任意 https 静态托管（GitHub Pages / Gist raw / OSS / 自己的 nginx），然后在 **设置 → 插件 → 发现（Discover）→ 索引源** 填 `…/index.json` 的地址。

本地临时验证可以用 `serve-index.ps1` 起静态服务 + cloudflared 隧道（脚本在包外，`D:\Personal\Downloads\yingyong\serve-index.ps1`）：

```powershell
powershell -ExecutionPolicy Bypass -File serve-index.ps1
```

隧道地址是 `https://<random>.trycloudflare.com/index.json`，**只在脚本运行期间有效**，进程一停地址就失效。要长期可用必须换固定托管。

### 有 npm 账号之后

```bash
npm login
cd D:/Personal/Downloads/yingyong/dsh-image-switch
node publish.mjs --publish            # 先 npm whoami 再 npm publish --access public
```

发成功后索引里的 `source.registry` 就已经指向 `https://registry.npmjs.org`，`marketInstallTarget()` 会推导出 `dsh-image-switch@1.0.0`，无需再改索引。

## 五、改名记录

原名 `dsh-image-router` 在 npm 上已被 `zhiwuli0228` 占用（`dsh-image-router@0.6.6`，做的是「视觉模型给图片转文字」，功能完全不同）。为避免撞名，发布名改为 **`dsh-image-switch`**。

改名同时做了状态目录迁移：旧 `~/.dsh/image-router/` → 新 `~/.dsh/image-switch/`，`lib/engine.js` 的 `legacyStateConfig()` / `legacyStateKeys()` 在首次运行时自动搬后端配置和密钥（`mode: 0o600`）。旧包源码保留在 `D:\Personal\Downloads\yingyong\dsh-image-router.archived\`。

DSH 侧的路由名 `img-router` **没有改**，所以已有模型引用 `img-router/autodl`、`img-router/local` 等继续有效。
