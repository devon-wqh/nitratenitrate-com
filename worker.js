// Workers entry point.
// - Logs a "view" for every page load and a "click" for /go/* links into a
//   permanent D1 table (env.DB), then serves the request.
// - Writes happen in ctx.waitUntil(), so they never slow the response.
// - "Visits" = distinct daily visitor hashes (SHA-256 of ip+ua+date); no
//   cookies and no raw IPs are stored.
// - /stats?key=... renders an all-time dashboard (key is a Worker secret).

const REDIRECTS = {
  "/go/tickets-iii":
    "https://www.slipperroom.com/event-details/guest-event-nitrate-iii-film-screening-july-7",
};

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS events (" +
        "id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, " +
        "path TEXT NOT NULL, referer TEXT, country TEXT, visitor TEXT)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)"),
  ]);
  schemaReady = true;
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function logEvent(env, request, type, path) {
  try {
    await ensureSchema(env);
    const ip = request.headers.get("cf-connecting-ip") || "";
    const ua = request.headers.get("user-agent") || "";
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const visitor = await sha256(`${ip}|${ua}|${day}`); // daily, no PII stored
    await env.DB.prepare(
      "INSERT INTO events (ts, type, path, referer, country, visitor) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(
        Date.now(),
        type,
        path,
        request.headers.get("referer") || "",
        request.cf?.country || "",
        visitor
      )
      .run();
  } catch (e) {
    // analytics must never break the site
  }
}

function isPageView(url) {
  const p = url.pathname;
  return p === "/" || p.endsWith(".html");
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function statsPage(env, url) {
  const key = url.searchParams.get("key") || "";
  if (!env.STATS_KEY || key !== env.STATS_KEY) {
    return new Response("Not found", { status: 404 });
  }
  await ensureSchema(env);

  const now = Date.now();
  const ms = { "1d": 864e5, "3d": 3 * 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5 };

  const one = async (sql, ...args) => {
    const stmt = args.length ? env.DB.prepare(sql).bind(...args) : env.DB.prepare(sql);
    return (await stmt.first("n")) ?? 0;
  };

  // All-time
  const [views, visits, clicks] = await Promise.all([
    one("SELECT count(*) AS n FROM events WHERE type='view'"),
    one("SELECT count(DISTINCT visitor) AS n FROM events"),
    one("SELECT count(*) AS n FROM events WHERE type='click'"),
  ]);

  // Trailing windows
  const periods = [
    { label: "1 day",   since: now - ms["1d"] },
    { label: "3 days",  since: now - ms["3d"] },
    { label: "7 days",  since: now - ms["7d"] },
    { label: "1 month", since: now - ms["30d"] },
  ];
  const windows = await Promise.all(
    periods.map(async ({ label, since }) => {
      const [v, u, c] = await Promise.all([
        one("SELECT count(*) AS n FROM events WHERE type='view' AND ts>?", since),
        one("SELECT count(DISTINCT visitor) AS n FROM events WHERE ts>?", since),
        one("SELECT count(*) AS n FROM events WHERE type='click' AND ts>?", since),
      ]);
      return { label, views: v, visits: u, clicks: c };
    })
  );

  // Tables
  const topPages = (await env.DB.prepare(
    "SELECT path, count(*) AS n FROM events WHERE type='view' GROUP BY path ORDER BY n DESC LIMIT 25"
  ).all()).results;
  const clickRows = (await env.DB.prepare(
    "SELECT path, count(*) AS n FROM events WHERE type='click' GROUP BY path ORDER BY n DESC"
  ).all()).results;
  const countries = (await env.DB.prepare(
    "SELECT country, count(*) AS n FROM events WHERE type='view' AND country<>'' GROUP BY country ORDER BY n DESC LIMIT 15"
  ).all()).results;

  const rows = (arr, label) =>
    arr.length
      ? arr.map((r) => `<tr><td>${esc(r.path ?? r.country ?? "—")}</td><td>${r.n}</td></tr>`).join("")
      : `<tr><td colspan="2" style="color:#999">no ${label} yet</td></tr>`;

  const periodRows = windows.map(({ label, views: v, visits: u, clicks: c }) =>
    `<tr><td>${label}</td><td>${v}</td><td>${u}</td><td>${c}</td></tr>`
  ).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="robots" content="noindex"><title>Nitrate stats</title>
<style>
  body{font-family:"EB Garamond",Georgia,serif;margin:2rem;max-width:680px;color:#000}
  h1{font-size:1.4rem} h2{font-size:1rem;margin-top:2rem;border-bottom:1px solid #000;padding-bottom:.2rem}
  .big{display:flex;gap:2rem;margin:1rem 0 1.5rem}
  .big div{font-size:.85rem;color:#555} .big b{display:block;font-size:1.8rem;color:#000}
  table{border-collapse:collapse;width:100%;font-size:.9rem}
  th{text-align:left;font-weight:normal;font-style:italic;padding:.25rem .5rem;border-bottom:1px solid #000}
  th:not(:first-child){text-align:right}
  td{padding:.25rem .5rem;border-bottom:1px solid #eee} td:not(:first-child){text-align:right;width:5rem}
</style></head><body>
<h1>Nitrate — stats</h1>

<h2>All time</h2>
<div class="big">
  <div>Views<b>${views}</b></div>
  <div>Visits<b>${visits}</b></div>
  <div>Ticket clicks<b>${clicks}</b></div>
</div>

<h2>Trailing periods</h2>
<table>
  <tr><th>Period</th><th>Views</th><th>Visits</th><th>Clicks</th></tr>
  ${periodRows}
</table>

<h2>Top pages</h2><table>${rows(topPages, "views")}</table>
<h2>Ticket clicks</h2><table>${rows(clickRows, "clicks")}</table>
<h2>Top countries</h2><table>${rows(countries, "data")}</table>
<p style="margin-top:2rem;color:#999;font-size:.8rem">Visits = unique visitors per day (no cookies, no IPs stored).</p>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Ticket-link clicks: count, then redirect.
    const dest = REDIRECTS[url.pathname];
    if (dest) {
      ctx.waitUntil(logEvent(env, request, "click", url.pathname.slice("/go/".length)));
      return Response.redirect(dest, 302);
    }

    // Private stats dashboard.
    if (url.pathname === "/stats") {
      return statsPage(env, url);
    }

    // Count page views (HTML only), then serve the static file.
    if (request.method === "GET" && isPageView(url)) {
      ctx.waitUntil(logEvent(env, request, "view", url.pathname));
    }
    return env.ASSETS.fetch(request);
  },
};
