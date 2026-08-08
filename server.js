/**
 * Standalone VixSrc stream resolver for Railway (or any host vixsrc.to does
 * not Cloudflare-block). Mirrors the logic in tvtime-app/app/api/vixsrc/stream
 * so the Vercel frontend can proxy native-stream resolution here.
 *
 *   GET /stream?type=tv|movie&id=<tmdbId>[&season=N&episode=N]
 *   GET /media?url=<enc(playlist|segment|init url)>  — byte proxy
 *   GET /health
 *
 * The resolver calls vixsrc's JSON API + embeds entirely server-side and
 * returns a signed HLS master playlist URL. The browser CANNOT fetch that URL
 * directly (Cloudflare 403s external origins), so /stream rewrites every
 * returned playlist URL to /media?url=..., and /media re-hosts the playlist +
 * segments through this server (same trick as the app's goated media proxy).
 * No CORS needed: hls.js fetches same-origin relative to the resolver URL.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const http = require("http");
const { Readable } = require("stream");
const { URL } = require("url");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PORT = Number(process.env.PORT || 8080);
const LANG = process.env.VIX_LANG || "en";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

// vixsrc playlist/segment hosts we are willing to proxy. Anything else 403s
// (never an open redirect). Segments live on vix-content.net subdomains
// (e.g. sc-u6-01.vix-content.net), so match the suffix, not just the apex.
const PROXY_HOSTS = new Set(["vixsrc.to", "www.vixsrc.to"]);

function isProxyableHost(hostname) {
  return (
    PROXY_HOSTS.has(hostname) ||
    hostname === "vix-content.net" ||
    hostname.endsWith(".vix-content.net")
  );
}

function isPlaylistContentType(ct) {
  return !!ct && ct.includes("mpegurl");
}

/**
 * Rewrite every absolute URL in an m3u8 that lives on a proxied host to a
 * /media?url=... call, so the whole segment chain flows through us. Also
 * rewrite absolute-path URIs (e.g. #EXT-X-KEY:URI="/storage/enc.key") to the
 * vixsrc origin through our proxy — hls.js would otherwise resolve them
 * against the resolver host and 404.
 *
 * vixsrc's master lists variants as https://vixsrc.to/media?url=<inner> —
 * unwrap those to their INNER url so we don't double-proxy (their /media
 * endpoint 404s on an already-nested call).
 */
function unwrapVixMediaUrl(full) {
  try {
    const u = new URL(full);
    if (u.hostname !== "vixsrc.to" && u.hostname !== "www.vixsrc.to") return full;
    if (!u.pathname.startsWith("/media")) return full;
    const inner = u.searchParams.get("url");
    if (!inner) return full;
    const innerUrl = new URL(inner);
    if (!isProxyableHost(innerUrl.hostname)) return full;
    return inner;
  } catch {
    return full;
  }
}

function rewriteBody(body) {
  // 1) Absolute http(s) URLs on proxyable hosts.
  let out = body.replace(/https?:\/\/[a-z0-9.-]+(\/[^\s"']*)/gi, (full) => {
    try {
      const unwrapped = unwrapVixMediaUrl(full);
      const u = new URL(unwrapped);
      if (!isProxyableHost(u.hostname)) return full;
      return `/media?url=${encodeURIComponent(unwrapped)}`;
    } catch {
      return full;
    }
  });
  // 2) Absolute-path URIs (URI="/storage/enc.key") → proxy via vixsrc origin.
  out = out.replace(
    /(URI=")\/([^"]*)/g,
    (_, pre, p) => `${pre}/media?url=${encodeURIComponent(`https://vixsrc.to/${p}`)}`
  );
  return out;
}

async function resolvePlaylist(type, id, season, episode) {
  const mediaPath =
    type === "tv" ? `tv/${id}/${season}/${episode}` : `movie/${id}`;
  const referer = `https://vixsrc.to/${mediaPath}`;

  const apiRes = await fetch(`https://vixsrc.to/api/${mediaPath}`, {
    headers: {
      "User-Agent": UA,
      Referer: referer,
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
  });
  if (!apiRes.ok) throw new Error(`vixsrc api ${apiRes.status}`);
  const apiJson = await apiRes.json();
  if (!apiJson.src) throw new Error("vixsrc api returned no src");

  const embedRes = await fetch(`https://vixsrc.to${apiJson.src}`, {
    headers: { "User-Agent": UA, Referer: referer, "Cache-Control": "no-cache" },
  });
  if (!embedRes.ok) throw new Error(`vixsrc embed ${embedRes.status}`);
  const html = await embedRes.text();

  const urlMatch = html.match(
    /window\.masterPlaylist\s*=\s*\{[\s\S]*?url:\s*'([^']+)'/
  );
  if (!urlMatch) throw new Error("no master playlist in embed page");

  const grab = (key) =>
    html.match(new RegExp(`'${key}':\\s*'([^']*)'`))?.[1] ?? "";
  const thumbMatch = html.match(/window\.thumbnailsUrl\s*=\s*'([^']+)'/);

  const params = new URLSearchParams();
  const token = grab("token");
  const expires = grab("expires");
  const asn = grab("asn");
  if (token) params.set("token", token);
  if (expires) params.set("expires", expires);
  if (asn) params.set("asn", asn);
  params.set("h", "1");
  params.set("lang", LANG);

  const playlist = new URL(urlMatch[1]);
  for (const [k, v] of params) playlist.searchParams.set(k, v);

  // The browser cannot fetch vixsrc.to/playlist/... directly (Cloudflare).
  // Hand back the URL rewritten through our own /media proxy so hls.js plays
  // the whole chain same-origin through the resolver.
  const proxiedPlaylist = `/media?url=${encodeURIComponent(playlist.toString())}`;

  return {
    ok: true,
    playlistUrl: proxiedPlaylist,
    thumbnailsUrl: thumbMatch?.[1] ?? null,
    season: type === "tv" ? season ?? null : null,
    episode: type === "tv" ? episode ?? null : null,
  };
}

/** Re-host a vixsrc playlist/segment through this server. */
async function proxyMedia(req, res, url) {
  const target = url.searchParams.get("url");
  if (!target) return json(res, 400, { error: "url required" });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json(res, 400, { error: "invalid url" });
  }
  // vixsrc's own /media?url=<inner> wrapper — fetch the inner URL directly
  // so we never double-proxy.
  if (
    (parsed.hostname === "vixsrc.to" || parsed.hostname === "www.vixsrc.to") &&
    parsed.pathname.startsWith("/media")
  ) {
    const inner = parsed.searchParams.get("url");
    if (inner) {
      try {
        parsed = new URL(inner);
      } catch {
        /* keep original — the host check below will reject it */
      }
    }
  }
  if (!isProxyableHost(parsed.hostname)) {
    return json(res, 403, { error: "host not allowed" });
  }

  const range = req.headers.range;
  let handled = false;
  try {
    const upstream = await fetch(parsed.toString(), {
      headers: {
        "User-Agent": UA,
        Referer: "https://vixsrc.to/",
        "Accept-Language": "en-US,en;q=0.9",
        ...(range ? { Range: range } : {}),
      },
      // Playlists must stay fresh; segment fetches get their own cache headers.
      cache: "no-store",
    });
    if (!upstream.ok) {
      res.writeHead(
        upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
        { "Content-Type": "application/json" }
      );
      res.end(JSON.stringify({ error: `upstream ${upstream.status}` }));
      return;
    }

    const contentType = upstream.headers.get("content-type") || "";
    console.log(`[media] ${parsed.hostname} ct=${contentType} status=${upstream.status}`);

    // Sub-playlists sometimes arrive as text/plain or octet-stream — sniff
    // for the #EXTM3U magic instead of trusting the header. Only buffer types
    // that could plausibly be a playlist; real segments (.ts/.m4s) have
    // video/* content-types and stream through untouched below.
    const couldBePlaylist =
      isPlaylistContentType(contentType) ||
      contentType.includes("text") ||
      contentType.includes("octet-stream") ||
      contentType === "";

    if (couldBePlaylist) {
      // Buffer as BYTES — never route binary through .text() (it corrupts
      // non-UTF8 data like AES keys). Sniff the #EXTM3U magic from the raw
      // bytes; only decode to a string when it's genuinely a playlist.
      const buf = Buffer.from(await upstream.arrayBuffer());
      const isPlaylist = buf.length > 6 && buf.subarray(0, 7).toString("latin1") === "#EXTM3U";
      if (isPlaylist) {
        const rewritten = rewriteBody(buf.toString("utf8"));
        res.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(rewritten);
        return;
      }
      // Not a playlist — send the exact bytes.
      res.writeHead(200, {
        "Content-Type": contentType || "application/octet-stream",
        "Content-Length": buf.length,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(buf);
      return;
    }

    // Binary pass-through (segments/init/aes key). Forward Range reply.
    const headers = {
      "Content-Type": contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
    };
    if (upstream.headers.get("content-range")) {
      headers["Content-Range"] = upstream.headers.get("content-range");
    }
    res.writeHead(upstream.status, headers);
    // Pipe the segment bytes. Errors mid-stream must NOT write a second
    // response (ERR_HTTP_HEADERS_SENT would crash the server) — destroy the
    // socket instead. "handled" (declared outside the try) prevents the catch
    // from double-writing.
    // WHATWG body → Node stream. fetch().body has no .pipe()/.on('error');
    // Readable.fromWeb gives a real Node Readable for pass-through.
    const nodeBody = Readable.fromWeb(upstream.body);
    nodeBody.on("error", (err) => {
      if (handled) return;
      handled = true;
      if (res.headersSent) {
        res.destroy(err);
      } else {
        json(res, 502, {
          error: err instanceof Error ? err.message : "proxy failed",
        });
      }
    });
    nodeBody.pipe(res);
  } catch (err) {
    if (handled || res.headersSent) {
      res.destroy(err);
      return;
    }
    return json(res, 502, {
      error: err instanceof Error ? err.message : "proxy failed",
    });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") {
    return json(res, 200, { ok: true, ts: new Date().toISOString() });
  }

  if (url.pathname === "/media") {
    return proxyMedia(req, res, url);
  }

  if (url.pathname !== "/" && url.pathname !== "/stream") {
    return json(res, 404, { error: "not found" });
  }

  const type = url.searchParams.get("type");
  const id = url.searchParams.get("id");
  const season = url.searchParams.get("season");
  const episode = url.searchParams.get("episode");

  if ((type !== "movie" && type !== "tv") || !id) {
    return json(res, 400, { error: "type (movie|tv) and id are required" });
  }

  resolvePlaylist(type, id, season, episode)
    .then((data) => json(res, 200, data))
    .catch((err) =>
      json(res, 502, {
        error: err instanceof Error ? err.message : "vix resolution failed",
      })
    );
});

server.listen(PORT, () => {
  console.log(`vix stream resolver listening on ${PORT}`);
});
