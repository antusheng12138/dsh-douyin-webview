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
 * 注入进每个 HTML 文档的同源改写脚本。必须在页面自己的脚本之前跑，所以插在
 * `<head>` 之后。它只改「发往 douyin 或本站绝对路径」的目标，`/__dyw` 自身与
 * data:/blob: 原样放过。
 */
const SHIM = `<script>(function(){var P=${JSON.stringify(PROXY_PREFIX)};var O='https://www.douyin.com';
function rw(u){try{if(typeof u!=='string')return u;
if(u.indexOf('data:')===0||u.indexOf('blob:')===0)return u;
if(u.indexOf(O)===0)return P+u.slice(O.length);
if(u.indexOf('http://www.douyin.com')===0)return P+u.slice('http://www.douyin.com'.length);
if(u.indexOf('//www.douyin.com')===0)return P+u.slice('//www.douyin.com'.length);
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

/** 上游把 Location 指回抖音时，改写到本地代理路径。 */
function rewriteLocation(value) {
  const at = String(value);
  if (at.startsWith(UPSTREAM_ORIGIN)) return PROXY_PREFIX + at.slice(UPSTREAM_ORIGIN.length);
  if (at.startsWith(`http://${UPSTREAM_HOST}`)) return PROXY_PREFIX + at.slice(`http://${UPSTREAM_HOST}`.length);
  if (at.startsWith(`//${UPSTREAM_HOST}`)) return PROXY_PREFIX + at.slice(`//${UPSTREAM_HOST}`.length);
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

function forward(req, res, targetPath) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  headers.host = UPSTREAM_HOST;
  // identity 便于 HTML 注入；上游若仍压缩，下面会解。
  headers['accept-encoding'] = 'identity';
  headers.referer = `${UPSTREAM_ORIGIN}/`;
  headers.origin = UPSTREAM_ORIGIN;
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
      host: UPSTREAM_HOST,
      port: 443,
      method: req.method,
      path: targetPath,
      headers,
      servername: UPSTREAM_HOST,
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
  forward(req, res, `${pathname}${search}`);
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
