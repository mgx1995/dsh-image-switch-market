# 把索引托管到 GitHub Pages

`gh-pages-build\` 里已经提交好了两个文件：`index.json` 与 `dsh-image-switch-1.0.0.tgz`。
下面这条命令会建仓库（若不存在）、推 `gh-pages` 分支、开启 Pages，并等站点可访问。

## 1. 建一个 PAT

<https://github.com/settings/tokens> → **Generate new token (classic)**
- Scope 只勾 **`repo`**（要建 private 仓库就必须有它；public 仓库也建议给）
- 有效期按自己习惯选，生成后**只显示一次**

细粒度 token（fine-grained）也可以，需要授予 **Administration: Read and write**（建仓库/开 Pages）
与 **Contents: Read and write**（推送）。

## 2. 跑脚本

```powershell
$env:GH_TOKEN = "ghp_你的token"
powershell -ExecutionPolicy Bypass -File "D:\Personal\Downloads\yingyong\push-gh-pages.ps1" `
  -User 你的用户名 -Repo dsh-image-switch-market
```

不想让 token 进环境变量，就写进一个文件再指过去：

```powershell
powershell -ExecutionPolicy Bypass -File "D:\Personal\Downloads\yingyong\push-gh-pages.ps1" `
  -User 你的用户名 -Repo dsh-image-switch-market `
  -TokenFile "C:\Users\Administrator\gh-token.txt"
```

脚本会打印最终地址：

```
https://<用户名>.github.io/dsh-image-switch-market/index.json
```

## 3. 在 DSH 里加索引

**设置 → 插件 → 发现 → 索引源**，粘贴上面那个 `.../index.json` 地址。
列表里会出现「生图路由 / Image Switch」，可直接安装。

## 备注

- 仓库必须是 **public**，Pages 才对匿名访问开放（private 仓库的 Pages 需要登录态，插件市场拉不到）。
- 想换分支名用 `-Branch main`；但 Pages 源也要跟着换，脚本会一起设好。
- 首次构建通常 30–90 秒，脚本最多等 200 秒；超时了就是还在构建，过几分钟手动打开那个地址即可。
- 以后更新版本：改完包 → `node publish.mjs --index-only` → 重新 `npm pack` 并把 tgz 拷进 `dsh-image-switch-market\` → 再跑一次本脚本（同名仓库会直接覆盖推送）。
