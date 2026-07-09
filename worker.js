// Workers entry point.
// - Logs a "view" for every page load and a "click" for /go/* links into a
//   permanent D1 table (env.DB), then serves the request.
// - Writes happen in ctx.waitUntil(), so they never slow the response.
// - "Visits" = distinct daily visitor hashes (SHA-256 of ip+ua+date); no
//   cookies and no raw IPs are stored.
// - /stats?key=... renders an all-time dashboard (key is a Worker secret).
// - /api/rsvp (POST) records an email or phone RSVP and forwards to Google
//   Sheets via RSVP_SHEET_URL (a Worker secret pointing at an Apps Script).
// - /api/checkout (POST) creates a Stripe Checkout Session for a ticket and
//   returns its hosted URL. Price is looked up server-side from TICKET_PRICES
//   below — never trust a price sent by the client.
// - /api/stripe-webhook (POST) receives Stripe's payment confirmation. The
//   signature is verified against STRIPE_WEBHOOK_SECRET before anything is
//   written, so a forged POST can't fake a paid ticket.

const REDIRECTS = {
  "/go/tickets-iii":
    "https://www.slipperroom.com/event-details/guest-event-nitrate-iii-film-screening-july-7",
};

// Ticket price in cents, keyed by event slug. Server-side only — the client
// never gets to say what it should be charged.
const TICKET_PRICES = {
  "nitrate-iv": 500,
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
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS rsvps (" +
        "id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, event TEXT NOT NULL, " +
        "type TEXT NOT NULL, value TEXT NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS tickets (" +
        "id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, event TEXT NOT NULL, " +
        "session_id TEXT UNIQUE NOT NULL, email TEXT, amount INTEGER NOT NULL, " +
        "status TEXT NOT NULL)"
    ),
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

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handleRsvp(env, request, ctx) {
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "Invalid request" }, 400); }

  const { event = "nitrate-iv", type, value } = body;
  if (!["email", "phone"].includes(type) || typeof value !== "string") {
    return jsonRes({ error: "Invalid input" }, 400);
  }
  const v = value.trim().slice(0, 200);
  if (!v) return jsonRes({ error: "Invalid input" }, 400);

  try {
    await ensureSchema(env);
    await env.DB.prepare("INSERT INTO rsvps (ts, event, type, value) VALUES (?, ?, ?, ?)")
      .bind(Date.now(), String(event).slice(0, 50), type, v)
      .run();
  } catch (e) {
    return jsonRes({ error: "Server error" }, 500);
  }

  // Forward to Google Sheet (non-blocking; fails silently if URL not set)
  if (env.RSVP_SHEET_URL) {
    ctx.waitUntil(
      fetch(env.RSVP_SHEET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, type, value: v, timestamp: new Date().toISOString() }),
      }).catch(() => {})
    );
  }

  return jsonRes({ ok: true });
}

async function handleCheckout(env, request, ctx, url) {
  if (!env.STRIPE_SECRET_KEY) return jsonRes({ error: "Ticketing not set up yet" }, 503);

  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "Invalid request" }, 400); }

  const event = String(body.event || "").slice(0, 50);
  const amount = TICKET_PRICES[event];
  if (!amount) return jsonRes({ error: "Unknown event" }, 400);

  const params = new URLSearchParams({
    mode: "payment",
    success_url: `${url.origin}/event-${event}.html?ticket=success`,
    cancel_url: `${url.origin}/event-${event}.html?ticket=cancelled`,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][product_data][name]": `Nitrate — ${event} ticket`,
    "line_items[0][price_data][unit_amount]": String(amount),
    "line_items[0][quantity]": "1",
    "metadata[event]": event,
  });

  let res, data;
  try {
    res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    data = await res.json();
  } catch (e) {
    return jsonRes({ error: "Stripe request failed" }, 502);
  }
  if (!res.ok) return jsonRes({ error: "Stripe error" }, 502);

  return jsonRes({ url: data.url });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")));
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  // Reject stale signatures (replay protection): 5 minute tolerance.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, v1);
}

async function handleStripeWebhook(env, request, ctx) {
  const payload = await request.text();
  const ok = env.STRIPE_WEBHOOK_SECRET
    ? await verifyStripeSignature(payload, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET)
    : false;
  if (!ok) return jsonRes({ error: "Invalid signature" }, 400);

  let evt;
  try { evt = JSON.parse(payload); } catch { return jsonRes({ error: "Invalid payload" }, 400); }

  if (evt.type === "checkout.session.completed") {
    const session = evt.data.object;
    const eventSlug = session.metadata?.event || "";
    const email = session.customer_details?.email || null;

    try {
      await ensureSchema(env);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO tickets (ts, event, session_id, email, amount, status) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(Date.now(), eventSlug, session.id, email, session.amount_total || 0, "paid")
        .run();
    } catch (e) {
      // Stripe retries on non-2xx, so surface the failure so it tries again.
      return jsonRes({ error: "Server error" }, 500);
    }

    if (env.RSVP_SHEET_URL) {
      ctx.waitUntil(
        fetch(env.RSVP_SHEET_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: eventSlug,
            type: "ticket",
            value: email || session.id,
            timestamp: new Date().toISOString(),
          }),
        }).catch(() => {})
      );
    }
  }

  return jsonRes({ ok: true });
}

async function statsPage(env, url) {
  const key = url.searchParams.get("key") || "";
  if (!env.STATS_KEY || key !== env.STATS_KEY) {
    return new Response("Not found", { status: 404 });
  }
  await ensureSchema(env);

  const now = Date.now();
  const nowHour = Math.floor(now / 3600000);
  const nowDay = Math.floor(now / 86400000);

  const one = async (sql, ...args) => {
    const stmt = args.length ? env.DB.prepare(sql).bind(...args) : env.DB.prepare(sql);
    return (await stmt.first("n")) ?? 0;
  };

  const [views, visits, clicks, tenMinRaw, hourlyRaw, dailyRaw, topPages, clickRows, countries, rsvpRows] =
    await Promise.all([
      one("SELECT count(*) AS n FROM events WHERE type='view'"),
      one("SELECT count(DISTINCT visitor) AS n FROM events"),
      one("SELECT count(*) AS n FROM events WHERE type='click'"),
      env.DB.prepare(
        "SELECT CAST(ts/600000 AS INTEGER) AS bucket, count(*) AS n " +
        "FROM events WHERE type='view' AND ts>? GROUP BY bucket ORDER BY bucket"
      ).bind(now - 72e5).all(),
      env.DB.prepare(
        "SELECT CAST(ts/3600000 AS INTEGER) AS bucket, count(*) AS n " +
        "FROM events WHERE type='view' AND ts>? GROUP BY bucket ORDER BY bucket"
      ).bind(now - 864e5).all(),
      env.DB.prepare(
        "SELECT CAST(ts/86400000 AS INTEGER) AS bucket, count(*) AS n " +
        "FROM events WHERE type='view' AND ts>? GROUP BY bucket ORDER BY bucket"
      ).bind(now - 30 * 864e5).all(),
      env.DB.prepare(
        "SELECT path, count(*) AS n FROM events WHERE type='view' GROUP BY path ORDER BY n DESC LIMIT 25"
      ).all(),
      env.DB.prepare(
        "SELECT path, count(*) AS n FROM events WHERE type='click' GROUP BY path ORDER BY n DESC"
      ).all(),
      env.DB.prepare(
        "SELECT country, count(*) AS n FROM events WHERE type='view' AND country<>'' GROUP BY country ORDER BY n DESC LIMIT 15"
      ).all(),
      env.DB.prepare(
        "SELECT ts, event, type, value FROM rsvps ORDER BY ts DESC LIMIT 200"
      ).all(),
    ]);

  // Trailing period totals
  const periods = [
    { label: "1 day",   since: now - 864e5 },
    { label: "3 days",  since: now - 3 * 864e5 },
    { label: "7 days",  since: now - 7 * 864e5 },
    { label: "1 month", since: now - 30 * 864e5 },
  ];
  const windows = await Promise.all(periods.map(async ({ label, since }) => {
    const [v, u, c] = await Promise.all([
      one("SELECT count(*) AS n FROM events WHERE type='view' AND ts>?", since),
      one("SELECT count(DISTINCT visitor) AS n FROM events WHERE ts>?", since),
      one("SELECT count(*) AS n FROM events WHERE type='click' AND ts>?", since),
    ]);
    return { label, views: v, visits: u, clicks: c };
  }));

  // Fill sparse DB results into complete arrays (zeros for missing buckets)
  const now10min = Math.floor(now / 600000);
  const tenMinMap = Object.fromEntries(tenMinRaw.results.map((r) => [r.bucket, r.n]));
  const tenMinFilled = Array.from({ length: 12 }, (_, i) => {
    const b = now10min - 11 + i;
    return { bucket: b, n: tenMinMap[b] || 0 };
  });

  const hourMap = Object.fromEntries(hourlyRaw.results.map((r) => [r.bucket, r.n]));
  const hourlyFilled = Array.from({ length: 24 }, (_, i) => {
    const b = nowHour - 23 + i;
    return { bucket: b, n: hourMap[b] || 0 };
  });

  const dayMap = Object.fromEntries(dailyRaw.results.map((r) => [r.bucket, r.n]));
  const dailyFilled = Array.from({ length: 30 }, (_, i) => {
    const b = nowDay - 29 + i;
    return { bucket: b, n: dayMap[b] || 0 };
  });

  const chartJson = JSON.stringify({ tenMin: tenMinFilled, hourly: hourlyFilled, daily: dailyFilled });

  // HTML helpers
  const rankRows = (results, col) =>
    results.length
      ? results.map((r, i) =>
          `<tr><td class="rank">${i + 1}</td><td>${esc(col === "country" ? r.country : r.path)}</td><td class="num">${r.n}</td></tr>`
        ).join("")
      : `<tr><td></td><td colspan="2" style="color:#999">no data yet</td></tr>`;

  const periodRowsHtml = windows
    .map(({ label, views: v, visits: u, clicks: c }) =>
      `<tr><td>${label}</td><td class="num">${v}</td><td class="num">${u}</td><td class="num">${c}</td></tr>`
    ).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Nitrate — stats</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  body{font-family:"EB Garamond",Georgia,serif;margin:2rem;max-width:720px;color:#000;background:#fff}
  h1{font-size:1.4rem;margin-bottom:.5rem}
  h2{font-size:1rem;margin-top:2rem;border-bottom:1px solid #000;padding-bottom:.2rem;margin-bottom:.75rem}
  .totals{display:flex;gap:2.5rem;margin:1rem 0 1.5rem}
  .totals div{font-size:.85rem;color:#555}
  .totals b{display:block;font-size:1.8rem;color:#000;line-height:1.2}
  .controls{display:flex;align-items:center;gap:1rem;margin-bottom:.75rem}
  select{font-family:inherit;font-size:.85rem;border:1px solid #ccc;padding:.2rem .5rem;background:#fff;cursor:pointer}
  .toggle{display:flex}
  .toggle button{font-family:inherit;font-size:.85rem;border:1px solid #ccc;padding:.2rem .7rem;background:#fff;cursor:pointer}
  .toggle button+button{border-left:none}
  .toggle button.active{background:#000;color:#fff;border-color:#000}
  canvas{max-height:180px;width:100%!important}
  table{border-collapse:collapse;width:100%;font-size:.9rem}
  th{text-align:left;font-weight:normal;font-style:italic;padding:.2rem .4rem;border-bottom:1px solid #000}
  th.num{text-align:right}
  td{padding:.2rem .4rem;border-bottom:1px solid #eee}
  td.rank{color:#bbb;width:1.5rem}
  td.num{text-align:right;width:4rem}
</style>
</head>
<body>
<h1>Nitrate — stats</h1>

<h2>All time</h2>
<div class="totals">
  <div>Views<b>${views}</b></div>
  <div>Visits<b>${visits}</b></div>
  <div>Ticket clicks<b>${clicks}</b></div>
</div>

<h2>Trending</h2>
<div class="controls">
  <select id="periodSel">
    <option value="2h">Last 2 hours</option>
    <option value="1d">Last 24 hours</option>
    <option value="3d">Last 3 days</option>
    <option value="7d" selected>Last 7 days</option>
    <option value="30d">Last 30 days</option>
  </select>
  <div class="toggle">
    <button id="lineBtn" class="active" onclick="setType('line')">Line</button>
    <button id="barBtn" onclick="setType('bar')">Bar</button>
  </div>
</div>
<canvas id="periodChart"></canvas>

<h2>Trailing periods</h2>
<table>
  <tr><th>Period</th><th class="num">Views</th><th class="num">Visits</th><th class="num">Clicks</th></tr>
  ${periodRowsHtml}
</table>

<h2>Top pages</h2>
<table>
  <tr><th></th><th>Page</th><th class="num">Views</th></tr>
  ${rankRows(topPages.results, "path")}
</table>

<h2>Ticket clicks</h2>
<table>
  <tr><th></th><th>Link</th><th class="num">Clicks</th></tr>
  ${rankRows(clickRows.results, "path")}
</table>

<h2>Top countries</h2>
<table>
  <tr><th></th><th>Country</th><th class="num">Views</th></tr>
  ${rankRows(countries.results, "country")}
</table>

<h2>RSVPs</h2>
<table>
  <tr><th>Date</th><th>Event</th><th>Type</th><th>Contact</th></tr>
  ${rsvpRows.results.length
    ? rsvpRows.results.map(r => {
        const d = new Date(r.ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
        return `<tr><td style="color:#999;white-space:nowrap">${d}</td><td>${esc(r.event)}</td><td>${esc(r.type)}</td><td>${esc(r.value)}</td></tr>`;
      }).join("")
    : `<tr><td colspan="4" style="color:#999">no RSVPs yet</td></tr>`
  }
</table>

<p style="margin-top:2rem;color:#999;font-size:.8rem">Visits = unique visitors per day (no cookies, no IPs stored). Times shown in your local timezone.</p>

<script>
var DATA = ${chartJson};
var ff = "'EB Garamond', Georgia, serif";
var baseOpts = {
  responsive: true,
  maintainAspectRatio: true,
  plugins: { legend: { display: false } },
  scales: {
    x: { grid: { display: false }, ticks: { font: { family: ff, size: 11 }, maxRotation: 0, autoSkipPadding: 8 } },
    y: { beginAtZero: true, ticks: { font: { family: ff, size: 11 }, precision: 0 }, grid: { color: "#f2f2f2" } }
  }
};

function mLabel(b) { return new Date(b * 600000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true }); }
function hLabel(b) { return new Date(b * 3600000).toLocaleTimeString([], { hour: "numeric", hour12: true }); }
function dLabel(b) { return new Date(b * 86400000 + 43200000).toLocaleDateString([], { month: "short", day: "numeric" }); }

// Toggleable period chart
var periodChart = null;
var curType = "line";

function periodData(sel) {
  if (sel === "2h") return {
    labels: DATA.tenMin.map(function(d) { return mLabel(d.bucket); }),
    vals: DATA.tenMin.map(function(d) { return d.n; })
  };
  if (sel === "1d") return {
    labels: DATA.hourly.map(function(d) { return hLabel(d.bucket); }),
    vals: DATA.hourly.map(function(d) { return d.n; })
  };
  var n = sel === "3d" ? 3 : sel === "7d" ? 7 : 30;
  var sl = DATA.daily.slice(-n);
  return { labels: sl.map(function(d) { return dLabel(d.bucket); }), vals: sl.map(function(d) { return d.n; }) };
}

function buildPeriod(sel, type) {
  if (periodChart) periodChart.destroy();
  var d = periodData(sel);
  var bar = type === "bar";
  periodChart = new Chart(document.getElementById("periodChart"), {
    type: type,
    data: {
      labels: d.labels,
      datasets: [{ data: d.vals,
        borderColor: "#000",
        backgroundColor: bar ? "rgba(0,0,0,0.75)" : "rgba(0,0,0,0.04)",
        borderWidth: bar ? 0 : 1.5,
        borderRadius: bar ? 2 : 0,
        pointRadius: bar ? 0 : 2,
        fill: !bar, tension: 0.3 }]
    },
    options: baseOpts
  });
}

function setType(t) {
  curType = t;
  document.getElementById("lineBtn").className = t === "line" ? "active" : "";
  document.getElementById("barBtn").className = t === "bar" ? "active" : "";
  buildPeriod(document.getElementById("periodSel").value, t);
}

document.getElementById("periodSel").addEventListener("change", function() { buildPeriod(this.value, curType); });
buildPeriod("7d", "line");
<\/script>
</body>
</html>`;

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

    // RSVP form submissions.
    if (url.pathname === "/api/rsvp" && request.method === "POST") {
      return handleRsvp(env, request, ctx);
    }

    // Ticket purchases.
    if (url.pathname === "/api/checkout" && request.method === "POST") {
      return handleCheckout(env, request, ctx, url);
    }
    if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
      return handleStripeWebhook(env, request, ctx);
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
