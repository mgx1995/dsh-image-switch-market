# dsh-image-switch

Switch which backend `generate_image` uses — local Stable Diffusion, Volcengine Ark (Doubao Seedream), AutoDL.Art, or any OpenAI-compatible image API — from a Settings page, with a key per backend.

## What it does

DeepSeek Harness resolves `generate_image` from the provider rows in the profile, so changing the image model normally means hand-editing `cordis.patch.yml`. This bundle puts a **Settings → Image routing** page in front of that: every backend is a card, and the one you mark as default is pushed into `dsh-model-think-level`, so later `generate_image` calls need no `model` argument.

## Install

```sh
# from the workspace that contains this directory
plugin_manager install_bundle /absolute/path/to/dsh-image-switch
```

Restart nothing: opening and re-enabling the bundle in **Settings → Plugins** is enough to pick up new Host-side code.

## Backends that ship with it

| name | kind | upstream | model |
| --- | --- | --- | --- |
| `doubao` | ark | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seedream-5-5-261028` |
| `autodl` | openai | `https://www.autodl.art/api/v1` | `doubao-seedream-5-0-flash` |
| `autodlz` | openai | `https://www.autodl.art/api/v1` | `Z-Image-Turbo` |
| `supooo` | openai | `https://www.supooo.com/v1` | `supooo.image` |
| `local` | openai | `http://127.0.0.1:1235/v1` | `sd1.5` |
| `local-base` | openai | `http://127.0.0.1:1235/v1` | `sd15-base` |

Models are addressed as `img-router/<backend name>`.

## Why a local middle layer

Upstream image APIs disagree on their request shape, and the caller is fixed:

- Volcengine Ark has **no `quality` parameter** and accepts only `1K` / `1.5K` / `2K` / `auto` or a pixel size inside `[921600, 4624220]`.
- AutoDL.Art wants a **bare token** (`Authorization: <key>`, no `Bearer`) and also rejects `quality`.
- Ark watermarks by default and answers with a **URL**, sometimes a JPEG.

So every request is normalized here: `quality` is dropped for backends that declare `stripQuality`, `n > 1` becomes several requests, `size` is mapped into the range the upstream accepts, `watermark: false` is sent to Ark, and any returned URL is downloaded and converted to PNG bytes (via ffmpeg or Pillow) because the caller declares `image/png` unconditionally.

## Adding your own backend

**Settings → Image routing → ＋ Add backend**, then fill in:

| field | meaning |
| --- | --- |
| name | the id you will type after `img-router/`, letters/digits/`_`/`-` only |
| base URL | the service root that answers `/images/generations`, e.g. `https://api.example.com/v1` |
| model | the upstream model id |
| auth prefix | `Bearer ` (default) or empty for services that want the bare token |
| strip quality | on when the upstream rejects a `quality` field |
| watermark | on to send `watermark: false` (Ark defaults to a visible watermark) |
| key | optional; leave blank to fall back to `apiKeyEnv` or `.credentials.yaml` |

Saving a backend also writes its row into the profile's `img-router` provider, so the model shows up on the **Models** page immediately. Deleting a backend removes that row again — the built-in ones included (their names go into `removed` in `config.json`, so they stay gone; re-adding a backend of the same name clears that entry). If the profile is busy the row write is retried; a `list / remove / add / sync` call through the `image_router` tool reports the same result. The **Sync to Models page** button on the panel re-runs that reconciliation by hand.

Delete removes on the first click and the header then offers **Undo**, which writes the full backend definition back.

## Configuration

- `~/.dsh/image-switch/config.json` — backend definitions and the active backend. Hand-editable; the page reloads it.
- `~/.dsh/image-switch/keys.json` — per-backend keys, written with mode `600`.

The provider rows under `providers['img-router']` in the profile's `cordis.patch.yml` are **generated** from `config.json`: the panel writes them through the profile's `configEditor` service, and only rows carrying `inputImageGen: true` belong to this bundle — rows you added by hand are left alone.

Key resolution order per backend: the key saved from this panel → `apiKey` in the backend definition → `process.env[apiKeyEnv]` → the `refs` section of `~/.dsh/.credentials.yaml`.

On first run it imports an existing `~/.dsh/image-router/config.json` or the older `image-shim/shim.json`, so an earlier install keeps its keys.

## Agent tool

`image_router` — `list` / `use` / `set_key` / `test` / `add` / `remove` / `sync`, the same implementation the Settings page calls. `add` and `remove` also report which model rows they added or removed on the Models page.

## Standalone endpoint

The bundle also listens on `127.0.0.1:1236` with an OpenAI-compatible `/v1/images/generations` and `/v1/images/edits`, because a provider `baseURL` has to be a fixed address — the DSH web port moves between launches. If 1236 is taken, the Settings page still works and generation through it keeps working; only the standalone listener is skipped.

`GET /health`, `GET /state`, `GET /v1/models`, `POST /admin/default`, `POST /admin/key`, `POST /admin/test` are available there too.

## License

MIT
