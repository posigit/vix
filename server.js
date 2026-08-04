/**
 * Standalone VixSrc stream resolver for Railway (or any host vixsrc.to does
 * not Cloudflare-block). Mirrors the logic in tvtime-app/app/api/vixsrc/stream
 * so the Vercel frontend can proxy native-stream resolution here.
 *
 *   GET /stream?type=tv|movie&id=<tmdbId>[&season=N&episode=N]
 *   GET /health
 *
 * The resolver calls vixsrc's JSON API + embeds entirely server-side and
 * returns a signed HLS master playlist URL. No CORS needed because the Vercel
 * route calls it server-to-server.
 */
const http = require("http");
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

  return {
    ok: true,
    playlistUrl: playlist.toString(),
    thumbnailsUrl: thumbMatch?.[1] ?? null,
    season: type === "tv" ? season ?? null : null,
    episode: type === "tv" ? episode ?? null : null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") {
    return json(res, 200, { ok: true, ts: new Date().toISOString() });
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

  try {
    return json(res, 200, await resolvePlaylist(type, id, season, episode));
  } catch (err) {
    return json(res, 502, {
      error: err instanceof Error ? err.message : "vix resolution failed",
    });
  }
});

server.listen(PORT, () => {
  console.log(`vix stream resolver listening on ${PORT}`);
});