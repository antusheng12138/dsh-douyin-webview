/**
 * dsh-douyin-webview — host half.
 *
 * 历史：Electron 桌面版里整套功能都在渲染进程，靠 preload 桥
 * `dshDesktop.browser.{acquire,release,onOpenRequested}` 拿一个真正的
 * `<webview>` guest（`resources/app.asar` → `lib/preload-app.cjs` / `lib/main.js`
 * 的 `DesktopBrowserGuests`）。那时宿主半边无事可做，所以是空 apply()。
 *
 * 2026-11-04（DSHM 端侧）：鸿蒙客户端里没有 preload 桥，没有 `<webview>` 标签，
 * 面板只能显示「这个窗口用不了内嵌抖音」。但宿主进程有 HTTP 服务，而 XFO/CSP 是
 * 「响应头」层面的限制 —— 只要页面从**同源**出来，iframe 就合法。所以这里补一条
 * 只转发抖音的本地反向代理：
 *
 *     GET /__dyw/<path>?<query>   →   https://www.douyin.com/<path>?<query>
 *
 * 它做四件事（顺序即重要性）：
 *   1. 剥掉 `X-Frame-Options` / `Content-Security-Policy` / `report-to` 一类
 *      「不许被嵌」的响应头；
 *   2. 把 `Set-Cookie` 的 `Domain=`/`Secure` 去掉、`SameSite=None` 降成 `Lax`，
 *      让抖音的 cookie 能落在 127.0.0.1 这个源上；
 *   3. HTML 响应里注入一段 shim，把页面内发往 `www.douyin.com` 的
 *      fetch / XHR / sendBeacon 改写到 `/__dyw` 前缀（抖音的接口不对本地
 *      Origin 回 ACAO，跨域直连必被 CORS 打回，只有同源改写才有戏）；
 *   4. 转发时把 `Referer`/`Origin` 换上游自己的、不把 GUI 的 `?token=` 泄出去。
 *
 * 明确不做的事：不是通用 forward proxy（只认 www.douyin.com），不碰登录/直播/
 * 人机验证链路。抖音的风控随时可能把这条路堵死（验证码中间页 = 死路），那时
 * 客户端会退回「用系统浏览器打开」的降级提示。
 *
 * 装配契约：`dsh-host-webserver` 的 `register({kind,path,handler})`，handler 独占
 * `(req,res)`。反代路径**不在** dsh-client-connection 的鉴权范围内（未注册路径才落
 * 到 fallback 静态查找），所以这里自己校验 Host，只服务本机回环地址。
 */
import https from 'node:https';
import zlib from 'node:zlib';

export const name = 'dsh-douyin-webview';
export const inject = ['webServer'];

/** 反代挂载前缀；客户端 iframe 指 `PROXY_PREFIX + '/'`。 */
export const PROXY_PREFIX = '/__dyw';
const UPSTREAM_HOST = 'www.douyin.com';
const UPSTREAM_ORIGIN = `https://${UPSTREAM_HOST}`;
/**
 * 允许被代理的同族域。两类都得管：
 *   - `live.douyin.com`：直播页的接口挂在这个域上，不接管就是「无网络」（实测日志
 *     `Access to XMLHttpRequest at 'https://live.douyin.com/webcast/setting/...'`）；
 *   - `ttwid.bytedance.com` / `mssdk.bytedance.com`：设备指纹注册与风控上报，断了
 *     这条链，api 一律回 `blocked`，页面有骨架没内容。
 * `zijieapi` / `snssdk` 是字节自家的监控与验证域，一起收进来省得再漏。仍然只认这些
 * 后缀，不是通用转发器。
 */
const UPSTREAM_ALLOW = /^([a-z0-9-]+[.])*(douyin|bytedance|zijieapi|snssdk)[.]com$/i;
/** 上游写死 www.douyin.com：这不是通用转发器，只认抖音这一个目标。 */
const REQUEST_TIMEOUT_MS = 30000;
/**
 * 抖音对 UA 很挑。DSHM 的 ArkWeb UA 里带 `Mobile` / `OpenHarmony` / `ArkWeb`，
 * 服务端会按移动端分支发页面，在 iframe 里表现为空白（实测 2026-11-04）。
 * Electron 那半边本来也是这么干的（`lib/client.js:757-760` 给 guest 设桌面 UA），
 * 所以转发时统一呈现成桌面 Chrome。
 */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 「别嵌我」的响应头，一律不转发；连接类头交给本地 hop 自己决定。 */
const DROP_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'report-to',
  'reporting-endpoints',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

/**
 * 注入进每个 HTML 文档的同源改写脚本。必须在页面自己的脚本之前跑。它只接管
 * fetch / XHR / sendBeacon（`<script>`/`<img>`/`<video>` 这些标签加载不受影响），
 * 命中抖音家族域就改写成 `/__dyw/<host>/<path>`，本站绝对路径也搬进代理；
 * `/__dyw` 自身、data:/blob: 原样放过。
 *
 * 为什么要连 `bytedance.com` 一起接管：页面的设备指纹（ttwid）注册与风控上报都挂在
 * `ttwid.bytedance.com` / `mssdk.bytedance.com`，那条链断了 api 就一律返回 `blocked`
 * （2026-11-04 实测：`/aweme/v1/web/tab/feed/` → 200 但 body 只有 7 字节 `blocked`），
 * 页面骨架能出来、一条内容都刷不到。
 */
const SHIM = `<script>(function(){var P=${JSON.stringify(PROXY_PREFIX)};
var OK=/([a-z0-9-]+[.])*(douyin|bytedance|zijieapi|snssdk)[.]com$/i;
var RE=/^(https?:)?[/]{2}([a-z0-9.-]+)(?=[/:]|$)/i;
function rw(u){try{if(typeof u!=='string')return u;
if(u.indexOf('data:')===0||u.indexOf('blob:')===0)return u;
var m=RE.exec(u);
if(m){var h=m[2].toLowerCase();if(OK.test(h)){var rest=u.slice(m[0].length);return P+'/'+h+(rest.charAt(0)==='/'?rest:'/'+rest);}}
if(u.charAt(0)==='/'){if(u===P||u.indexOf(P+'/')===0)return u;return P+u;}
return u;}catch(e){return u;}}
try{var of=window.fetch;if(of){window.fetch=function(i,o){try{
if(typeof i==='string'){i=rw(i);}else if(i&&typeof i.url==='string'&&!i.bodyUsed){var n=rw(i.url);if(n!==i.url){i=new Request(n,{method:i.method,headers:i.headers,body:i.body===null?null:i.body,mode:i.mode,credentials:i.credentials,cache:i.cache,redirect:i.redirect,referrer:i.referrer,integrity:i.integrity,keepalive:i.keepalive,signal:i.signal});}}}catch(e){}
return of.call(this,i,o);};}}catch(e){}
try{var op=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var a=Array.prototype.slice.call(arguments);if(a.length>1)a[1]=rw(u);return op.apply(this,a);};}catch(e){}
try{var sb=window.navigator.sendBeacon;if(sb)window.navigator.sendBeacon=function(u,d){return sb.call(window.navigator,rw(u),d);};}catch(e){}
})();</script>`;

/** 只服务本机：Host 头必须是回环地址。 */
function isLoopbackHost(req) {
  const raw = String(req.headers.host ?? '');
  const name = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '0:0:0:0:0:0:0:1';
}

/** `Set-Cookie` 落到本地源：去 Domain/Secure，SameSite=None 降 Lax。 */
function rewriteSetCookie(line) {
  return line
    .replace(/;\s*Domain=[^;]*/gi, '')
    .replace(/;\s*Secure\b/gi, '')
    .replace(/;\s*SameSite=None/gi, '; SameSite=Lax');
}

/** 上游把 Location 指回抖音家族时，改写到本地代理路径（保留原 host 段）。 */
function rewriteLocation(value) {
  const at = String(value);
  const m = /^(https?:)?[/]{2}([a-z0-9.-]+)(?=[/:]|$)/i.exec(at);
  if (m !== null) {
    const host = m[2].toLowerCase();
    if (UPSTREAM_ALLOW.test(host)) {
      const rest = at.slice(m[0].length);
      return `${PROXY_PREFIX}/${host}${rest.startsWith('/') ? rest : `/${rest}`}`;
    }
  }
  return at;
}

/** 解不开就返回 null —— 那种响应绝不能当文本注入，原样透传即可。 */
function tryDecode(buffer, encoding) {
  const enc = String(encoding ?? '').toLowerCase();
  if (enc === '') return buffer;
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer);
    if (enc === 'deflate') return zlib.inflateSync(buffer);
    if (enc === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    return null;
  }
  return null;
}

/** 把 shim 插进 HTML 的最前面（`<head>` 之后优先）。 */
function injectShim(html) {
  const text = html.toString('utf8');
  // 插在**第一个 charset meta 之后**：shim 本身有一千多字节，顶到最前会把 charset
  // 声明挤出前 1024 字节的探测窗口，中文页按错编码解析就乱码。没有 charset 再退到
  // `<head>` 之后，最后才顶到最前。
  let withShim;
  if (/<meta[^>]*charset[^>]*>/i.test(text)) withShim = text.replace(/<meta[^>]*charset[^>]*>/i, (m) => m + SHIM);
  else if (/<head[^>]*>/i.test(text)) withShim = text.replace(/<head[^>]*>/i, (m) => m + SHIM);
  else withShim = SHIM + text;
  return Buffer.from(withShim, 'utf8');
}

function forward(req, res, targetPath, upstreamHost) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  headers.host = upstreamHost;
  // identity 便于 HTML 注入；上游若仍压缩，下面会解。
  headers['accept-encoding'] = 'identity';
  headers.referer = `https://${upstreamHost}/`;
  headers.origin = `https://${upstreamHost}`;
  // 桌面 UA（见 DESKTOP_UA 注释）：不然抖音按移动端发页面，iframe 里一片空白。
  const incomingUa = String(headers['user-agent'] ?? '');
  if (incomingUa === '' || /Mobile|OpenHarmony|ArkWeb|Electron|HarmonyOS/i.test(incomingUa)) {
    headers['user-agent'] = DESKTOP_UA;
  }
  // 宿主自己的会话 cookie（dsh-auth-* 一类，HttpOnly + SameSite=Strict）绝不能跟去
  // 抖音 —— 那是本机凭据。抖音只需要它自己发的 __ac_* / ttwid / msToken 这些。
  if (typeof headers.cookie === 'string') {
    const kept = headers.cookie
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !/^(dsh[-_]|__dsh)/i.test(part))
      .join('; ');
    if (kept.length === 0) delete headers.cookie;
    else headers.cookie = kept;
  }

  const upstream = https.request(
    {
      host: upstreamHost,
      port: 443,
      method: req.method,
      path: targetPath,
      headers,
      servername: upstreamHost,
    },
    (up) => {
      const status = up.statusCode ?? 502;
      const rawType = String(up.headers['content-type'] ?? '');
      // 304/204/HEAD 没有实体：绝不能往里塞 shim（304 带 body 是违规的）。
      const noBody = req.method === 'HEAD' || status === 204 || status === 304;
      const isHtml = !noBody && rawType.includes('text/html');

      const out = {};
      for (const [key, value] of Object.entries(up.headers)) {
        if (DROP_RESPONSE_HEADERS.has(key) || value === undefined) continue;
        if (key === 'set-cookie') continue;
        if (key === 'location') {
          out.location = rewriteLocation(value);
          continue;
        }
        out[key] = value;
      }
      const cookies = up.headers['set-cookie'];
      if (Array.isArray(cookies)) {
        out['set-cookie'] = cookies.map(rewriteSetCookie);
      } else if (typeof cookies === 'string') {
        out['set-cookie'] = rewriteSetCookie(cookies);
      }
      if (isHtml) delete out['content-length'];

      if (noBody) {
        res.writeHead(status, out);
        up.resume();
        res.end();
        return;
      }

      if (!isHtml) {
        res.writeHead(status, out);
        up.pipe(res);
        return;
      }

      const chunks = [];
      up.on('data', (chunk) => chunks.push(chunk));
      up.on('end', () => {
        const raw = Buffer.concat(chunks);
        const decoded = tryDecode(raw, up.headers['content-encoding']);
        // 解不开就原样透传（保留 content-encoding），免得把二进制当文本毁了。
        const body = decoded === null ? raw : injectShim(decoded);
        if (decoded !== null) delete out['content-encoding'];
        out['content-type'] = rawType.includes('charset') ? rawType : `${rawType}; charset=utf-8`;
        try {
          res.writeHead(status, out);
          res.end(body);
        } catch {
          /* 客户端已经断开 */
        }
      });
    },
  );

  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`douyin proxy upstream error: ${String(error?.message ?? error)}`);
  });
  upstream.setTimeout(REQUEST_TIMEOUT_MS, () => upstream.destroy(new Error('upstream timeout')));
  req.pipe(upstream);
}

/** JSON 响应小工具。 */
function respondJson(res, status, payload) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (error) {
    body = JSON.stringify({ ok: false, error: `序列化失败：${String(error)}` });
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/* ------------------------------------------------------------------ *
 * 播放器：分享链接 / 口令 → 无水印直链
 *
 * 走**移动分享页**（服务端渲染），不走 PC 站：www.douyin.com 的视频页由 JS 虚拟机
 * （`_$jsvmprt`）渲染并带签名校验，纯 HTTP 什么都拿不到；而
 * `https://www.iesdouyin.com/share/video/<id>/` 的数据直接躺在 HTML 的
 * `window._ROUTER_DATA` 里。这也是 douyin-kit/douyin_kit/fetcher.py 的路子。
 *
 * 两个实测坑：
 *   1. 两段式反爬：首次请求只下发 ttwid Cookie 并返回空壳页，**必须复用同一个
 *      会话**再请求一次才有数据 —— 换新会话永远拿不到；
 *   2. 能从输入直接确定 aweme_id 的，别先去请求原始链接（PC 站会下发反爬 Cookie）。
 * ------------------------------------------------------------------ */

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const SHARE_TMPL = 'https://www.iesdouyin.com/share/video/{id}/';
const SHARE_URL_RE = /https?:\/\/[^\s\u4e00-\u9fff，。、；：？！“”‘’（）()\[\]【】<>]+/;
const AWEME_ID_RE = /(?:\/video\/|\/share\/video\/|modal_id=|item_ids=)(\d{15,25})/;
const BARE_ID_RE = /(?<!\d)(\d{19})(?!\d)/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 极简 cookie 罐：ttwid 这类会话 cookie 够用了。 */
function createCookieJar() {
  const store = new Map();
  return {
    absorb(list) {
      if (!Array.isArray(list)) return;
      for (const line of list) {
        const pair = String(line).split(';')[0];
        const at = pair.indexOf('=');
        if (at > 0) store.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
    },
    header() {
      if (store.size === 0) return {};
      return { cookie: [...store].map(([key, value]) => `${key}=${value}`).join('; ') };
    },
  };
}

/** 跟随重定向的 GET（最多 6 跳），全程带同一个 cookie 罐。 */
function httpGetText(url, jar, redirects = 0) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`不是合法 URL：${url}`));
      return;
    }
    const request = https.request(
      {
        host: target.hostname,
        port: 443,
        method: 'GET',
        path: `${target.pathname}${target.search}`,
        servername: target.hostname,
        headers: {
          'user-agent': MOBILE_UA,
          'accept-language': 'zh-CN,zh;q=0.9',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-encoding': 'identity',
          ...jar.header(),
        },
      },
      (up) => {
        jar.absorb(up.headers['set-cookie']);
        const status = up.statusCode ?? 0;
        const location = up.headers.location;
        if (status >= 300 && status < 400 && typeof location === 'string' && redirects < 6) {
          up.resume();
          resolve(httpGetText(new URL(location, url).toString(), jar, redirects + 1));
          return;
        }
        const chunks = [];
        up.on('data', (chunk) => chunks.push(chunk));
        up.on('end', () => resolve({ status, url, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    request.on('error', reject);
    request.setTimeout(25000, () => request.destroy(new Error('上游超时')));
    request.end();
  });
}

function firstMatch(pattern, text) {
  const m = pattern.exec(String(text ?? ''));
  return m === null ? null : m[1];
}

/** 从分享页 HTML 里抠 `_ROUTER_DATA` 的 JSON（花括号配对，避免被转义坑）。 */
function extractRouterData(html) {
  const at = html.indexOf('_ROUTER_DATA');
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 「这份 _ROUTER_DATA 里到底有没有真数据」——空壳页的 loaderData 里没有 videoInfoRes。 */
function hasVideoPage(data) {
  const loader = (data ?? {}).loaderData ?? {};
  return Object.values(loader).some((value) => value !== null && typeof value === 'object' && 'videoInfoRes' in value);
}

function normalizeItem(data, awemeId) {
  const loader = (data ?? {}).loaderData ?? {};
  let page = null;
  for (const value of Object.values(loader)) {
    if (value !== null && typeof value === 'object' && value.videoInfoRes) {
      page = value;
      break;
    }
  }
  if (page === null) throw new Error('分享页里没有 videoInfoRes');
  const result = page.videoInfoRes ?? {};
  const item = (result.item_list ?? [])[0];
  if (!item) throw new Error(`平台没返回视频数据（status_code=${result.status_code}；可能已删除或需要登录）`);
  const video = item.video ?? {};
  const author = item.author ?? {};
  const playList = ((video.play_addr ?? {}).url_list ?? []);
  const coverList = ((video.cover ?? {}).url_list ?? []);
  return {
    awemeId,
    desc: String(item.desc ?? ''),
    author: String(author.nickname ?? ''),
    durationSec: Math.round(Number(video.duration ?? 0) / 100) / 10,
    cover: coverList[0] ?? '',
    // playwm 端点带水印，换成 play 就是原始流。
    playUrl: String(playList[0] ?? '').replace('/playwm/', '/play/'),
    images: (item.images ?? []).map((img) => (img?.url_list ?? [])[0]).filter((url) => typeof url === 'string'),
    web: `https://www.douyin.com/video/${awemeId}`,
  };
}

/** 对外主流程：任意分享文本 → 归一化的可播信息。 */
async function resolveDouyin(text) {
  const input = String(text ?? '').trim();
  if (input === '') throw new Error('先把分享链接或口令贴进来');
  const jar = createCookieJar();
  let awemeId = firstMatch(AWEME_ID_RE, input) ?? firstMatch(BARE_ID_RE, input);
  if (awemeId === null) {
    const url = firstMatch(SHARE_URL_RE, input);
    if (url === null) throw new Error('在输入里没找到链接或 19 位视频 ID');
    const opened = await httpGetText(url, jar);
    awemeId =
      firstMatch(AWEME_ID_RE, opened.url ?? '') ??
      firstMatch(AWEME_ID_RE, opened.body) ??
      firstMatch(BARE_ID_RE, opened.body);
    if (awemeId === null) throw new Error('短链展开后没解析出视频 ID');
    const early = extractRouterData(opened.body);
    if (early !== null && hasVideoPage(early)) return normalizeItem(early, awemeId);
  }
  const shareUrl = SHARE_TMPL.replace('{id}', awemeId);
  let lastError = '未知错误';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const page = await httpGetText(shareUrl, jar);
    const data = extractRouterData(page.body);
    if (data !== null && hasVideoPage(data)) return normalizeItem(data, awemeId);
    lastError = `分享页回了空壳（第 ${attempt + 1} 次，${page.body.length} 字节）`;
    if (attempt < 2) await sleep(1200);
  }
  throw new Error(`${lastError}；多半是平台风控，过一会儿再点一次`);
}

function handler(req, res) {
  if (!isLoopbackHost(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('douyin proxy: loopback only');
    return;
  }
  let raw = String(req.url ?? '/');
  const queryAt = raw.indexOf('?');
  let pathname = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const search = queryAt === -1 ? '' : raw.slice(queryAt);

  if (pathname === PROXY_PREFIX) {
    res.writeHead(302, { location: `${PROXY_PREFIX}/${search}` });
    res.end();
    return;
  }
  if (!pathname.startsWith(`${PROXY_PREFIX}/`)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('douyin proxy: bad prefix');
    return;
  }
  pathname = pathname.slice(PROXY_PREFIX.length);
  if (pathname === '/__ping') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, upstream: UPSTREAM_ORIGIN, prefix: PROXY_PREFIX }));
    return;
  }
  // 播放器用的解析接口：分享链接/口令 → 无水印可播直链。走的是移动分享页 SSR，
  // 不碰 PC 站那套签名（见 resolveDouyin 的注释）。
  if (pathname === '/parse') {
    const text = new URL(`http://loopback.invalid${raw}`).searchParams.get('text') ?? '';
    void resolveDouyin(text).then(
      (data) => respondJson(res, 200, { ok: true, data }),
      (error) => respondJson(res, 502, { ok: false, error: String(error?.message ?? error) }),
    );
    return;
  }
  // 两种形态：`/__dyw/<path>`（默认上游 www.douyin.com）与 `/__dyw/<host>/<path>`
  // （把 live.douyin.com 一类同族域也搬到同源来）。host 段只认 *.douyin.com。
  const rest = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  const slash = rest.indexOf('/');
  const first = slash === -1 ? rest : rest.slice(0, slash);
  let upstreamHost = UPSTREAM_HOST;
  let target = pathname;
  if (first.includes('.') && UPSTREAM_ALLOW.test(first)) {
    upstreamHost = first.toLowerCase();
    target = slash === -1 ? '/' : rest.slice(slash);
  }
  forward(req, res, `${target}${search}`, upstreamHost);
}

/**
 * 注册 `/__dyw` 路由。宿主半边只做这一件事；Electron 那边照旧走 preload 桥，
 * 客户端会先探测这边是否可用（`GET /__dyw/__ping`）再决定用哪种挂载方式。
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: PROXY_PREFIX, handler }),
      'dsh-douyin-webview: /__dyw douyin reverse proxy',
    );
  });
}
