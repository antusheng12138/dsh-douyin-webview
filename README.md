# dsh-douyin-webview

An embedded Douyin window docked in the DSH sidebar footer — watch Douyin in the
bottom-left corner while you keep working.

> **Desktop:** the panel mounts a real Electron `<webview>` through the preload
> bridge (`dshDesktop.browser.acquire`).
>
> **DSHM / 浏览器形态（2026-11-04 起）：** 没有 preload 桥、也没有 `<webview>`
> 标签时，宿主半边会用一条**本地反向代理**把抖音搬到同源 `/__dyw`，面板改用
> `<iframe>` 指过去 —— 同源文档不受 `X-Frame-Options` 约束，所以这条路也能嵌。
> 两条路都不可用时，面板才显示「内嵌抖音暂时没起来」并给一个「在浏览器打开抖音」
> 的入口。

## Two ways to embed, and why

**Electron Desktop — a `<webview>` guest.** `douyin.com` answers with
`X-Frame-Options: DENY` and a CSP `frame-ancestors` list that does not include
`127.0.0.1`, so an iframe is rejected outright. A `<webview>` is a separate
renderer guest, which `frame-ancestors` cannot reach.

**DSHM（鸿蒙客户端 / 任何无 Electron 的形态）— a same-origin reverse proxy.**
客户端没有 preload 桥，也就没有 guest 租约。这里换一条路：宿主半边
（`lib/index.js`）注册 `prefix` 路由 `/__dyw`，把请求转发到
`https://www.douyin.com`，并做四件事 ——

1. 剥掉 `X-Frame-Options` / `Content-Security-Policy` / `report-to` 一类
   「不许被嵌」的响应头；
2. `Set-Cookie` 去掉 `Domain=`/`Secure`、`SameSite=None` 降成 `Lax`，让抖音的
   cookie 落在 `127.0.0.1:3120` 这个源上；
3. HTML 响应里注入一段 shim，把页面内发往 `www.douyin.com` 的
   `fetch` / `XMLHttpRequest` / `sendBeacon` 改写到 `/__dyw`（抖音的接口不对本地
   `Origin` 回 `Access-Control-Allow-Origin`，跨域直连必被 CORS 打回）；
4. 转发时不把 GUI 的 `Referer`（含 `?token=`）带出去。

这条路由**只服务回环地址、只认 `www.douyin.com`**，不是通用 forward proxy；它也
不在 `dsh-client-connection` 的鉴权范围内，所以自己做 Host 校验。

代价要讲清楚：抖音的风控随时可能把这条路堵死（`__ac_signature` 算不过就直接进
「验证码中间页」）。真到那一步，面板会退回降级提示 + 浏览器入口，而不是白屏。

## What it does

- A 抖音 button in the sidebar footer toggles the panel.
- The panel opens at the bottom-left, **above that button**, at 480×300
  (480×270 of 16:9 content under a 30px title bar).
- The title bar carries the size badge on the left and, on the right, a status
  dot (grey while the page loads, green once it is ready) and the close button.
  Click the badge to switch between 小窗口 and 大窗口; the large step fills the
  height available between the title bar and the footer.
- Drag anywhere on the title bar to move it; it snaps to the viewport edges.
- **Double-click inside the page** (or use Douyin's own fullscreen control) to
  take the video full-frame *inside the panel*.

## Notes

- The `partition` comes from the Desktop guest lease, so the Douyin login
  survives panel close/reopen. Keep the partition persistent (see
  `dsh-侧栏浏览器分区持久化`) if you want it to survive a restart too.
- Douyin's own `⛶` control is intercepted and re-implemented in-page: Electron's
  `WEB_VIEW_ATTRIBUTES` has no `allowfullscreen`, so the native request would be
  silently denied. The shim rewrites the Fullscreen API inside the guest and
  scales the video to the panel's own viewport.
- The panel colours follow the host theme tokens (`--dsw-alias-bg-base`,
  `--dsw-alias-bg-layer-1`), so it matches whichever skin you run.

## Install

```sh
dsh plugin --profile desktop add dsh-douyin-webview
```

or list the package in your profile's `dsh.profile.bundles`.

## Licence

MIT
