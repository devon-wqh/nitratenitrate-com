// Workers entry point.
// - Logs a "view" for every page load and a "click" for /go/* links into a
//   permanent D1 table (env.DB), then serves the request.
// - Writes happen in ctx.waitUntil(), so they never slow the response.
// - "Visits" = distinct daily visitor hashes (SHA-256 of ip+ua+date); no
//   cookies and no raw IPs are stored.
// - /stats?key=... renders an all-time dashboard (key is a Worker secret).
// - /api/rsvp (POST) records an email or phone RSVP and forwards to Google
//   Sheets via RSVP_SHEET_URL (a Worker secret pointing at an Apps Script).
// - Ticketing runs on Stripe Embedded Checkout, so the payment form is mounted
//   inside our own page and nobody leaves the site:
//     /api/tickets-remaining  seats left (drives the sold-out state)
//     /api/checkout           creates a Checkout Session, returns client_secret
//     /api/checkout-status    what the return page asks after payment
//     /api/stripe-webhook     Stripe tells us a payment landed -> orders table,
//                             then emails the buyer their confirmation
//   Needs two Worker secrets, STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, plus
//   the (public) STRIPE_PUBLISHABLE_KEY var in wrangler.toml.

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
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS rsvps (" +
        "id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, event TEXT NOT NULL, " +
        "type TEXT NOT NULL, value TEXT NOT NULL)"
    ),
    // Ticket sales. session_id is UNIQUE so a repeated webhook delivery
    // updates the existing row instead of double-counting a sale.
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS orders (" +
        "id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL UNIQUE, " +
        "event TEXT NOT NULL, email TEXT, name TEXT, quantity INTEGER NOT NULL, " +
        "amount_cents INTEGER NOT NULL, status TEXT NOT NULL)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_orders_event ON orders(event, status)"),
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

// ---------------------------------------------------------------------------
// Ticketing (Stripe Embedded Checkout)
//
// Prices and capacity live here, on the server, so they can't be tampered with
// from the browser. To add the New York show later, add another entry.
//
//   priceCents  price per ticket, in cents (1500 = $15.00)
//   capacity    hard seat cap; checkout refuses once it's reached
//   maxPerOrder most tickets one person can buy in a single order
//   holdMinutes how long an unfinished checkout keeps holding its seats. This
//               is also passed to Stripe as the session's expires_at, so a
//               lapsed hold can never come back and oversell the room. Stripe
//               requires at least 30 minutes, so don't go below ~35.
// ---------------------------------------------------------------------------
const HOLD_MINUTES = 35;   // Stripe's floor for expires_at is 30; don't go under ~35.

const TICKETS = {
  "la-horror-shorts": {
    name: "LA Horror Shorts @ Videotheque",
    description: "Oct 6, 2026 · Doors 7pm · 4102 N Figueroa St, Los Angeles",
    when: "October 6, 2026",
    doors: "Doors 7pm · Films begin promptly at 8pm",
    venue: "Videotheque",
    address: "4102 N Figueroa St, Los Angeles, CA",
    priceCents: 1500,
    capacity: 50,
    maxPerOrder: 6,
    sheetTab: "LA Horror Shorts",
  },

  "la-doc-shorts": {
    name: "LA Doc Shorts @ Videotheque",
    description: "Oct 2, 2026 · Doors 7pm · 4102 N Figueroa St, Los Angeles",
    when: "October 2, 2026",
    doors: "Doors 7pm · Films begin promptly at 8pm",
    venue: "Videotheque",
    address: "4102 N Figueroa St, Los Angeles, CA",
    priceCents: 1500,
    capacity: 50,
    maxPerOrder: 6,
    sheetTab: "LA Doc Shorts",
  },

  // A ticket type in its own right, not a discount code. Buying one takes a
  // seat at BOTH shows and puts the buyer on both door lists, flagged as a
  // double header. It has no capacity of its own — it's bounded by whichever
  // of the two shows has less room left.
  "la-double-header": {
    name: "LA Double Header — Horror Shorts + Doc Shorts",
    description: "Oct 2 + Oct 6, 2026 · Videotheque",
    shortLabel: "Double header",
    includes: ["la-horror-shorts", "la-doc-shorts"],
    priceCents: 2000,
    maxPerOrder: 6,
  },
};

// Bundles that put their buyer on this show's door list.
function bundlesCovering(eventKey) {
  return Object.keys(TICKETS).filter(
    (k) => (TICKETS[k].includes || []).includes(eventKey)
  );
}

// Every ticket type that consumes a seat at this show: the show itself, plus
// any double header that includes it.
function keysHolding(eventKey) {
  return [eventKey, ...bundlesCovering(eventKey)];
}

// Confirmation emails come from here. The domain must be onboarded first:
//   npx wrangler email sending enable nitratenitrate.com
const TICKET_FROM = { email: "tickets@nitratenitrate.com", name: "Nitrate" };

// Call the Stripe REST API directly. No SDK: this Worker has no build step,
// and the two endpoints we need are a single form-encoded POST each.
async function stripeApi(env, path, params, method = "POST") {
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (params) init.body = new URLSearchParams(params).toString();

  const res = await fetch(`https://api.stripe.com/v1/${path}`, init);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error?.message || `Stripe ${res.status}`);
  }
  return body;
}

// Seats that are spoken for: paid orders, plus pending checkouts still inside
// their hold window. Abandoned checkouts release their seats automatically.
async function seatsTaken(env, eventKey) {
  const keys = keysHolding(eventKey);
  const cutoff = Date.now() - HOLD_MINUTES * 60000;
  const marks = keys.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT COALESCE(sum(quantity), 0) AS n FROM orders ` +
      `WHERE event IN (${marks}) AND (status = 'paid' OR (status = 'pending' AND ts > ?))`
  )
    .bind(...keys, cutoff)
    .first();
  return row?.n ?? 0;
}

// Seats left for a ticket type. A double header can only sell as many as the
// tighter of its two shows allows.
async function remainingFor(env, key) {
  const cfg = TICKETS[key];
  if (!cfg) return 0;
  if (cfg.includes) {
    const each = await Promise.all(cfg.includes.map((k) => remainingFor(env, k)));
    return Math.max(0, Math.min(...each));
  }
  return Math.max(0, cfg.capacity - (await seatsTaken(env, key)));
}

async function handleTicketsRemaining(env, url) {
  const eventKey = url.searchParams.get("event") || "";
  const cfg = TICKETS[eventKey];
  if (!cfg || cfg.includes) return jsonRes({ error: "Unknown event" }, 404);

  await ensureSchema(env);

  // The show on its own, then any double header that includes it.
  const keys = [eventKey, ...bundlesCovering(eventKey)];
  const options = [];
  for (const k of keys) {
    const c = TICKETS[k];
    const remaining = await remainingFor(env, k);
    options.push({
      key: k,
      label: c.includes ? c.shortLabel || c.name : "This show only",
      bundle: !!c.includes,
      priceCents: c.priceCents,
      remaining,
      soldOut: remaining === 0,
      maxPerOrder: Math.min(c.maxPerOrder, remaining),
    });
  }

  const own = options[0];
  return jsonRes({
    remaining: own.remaining,
    soldOut: own.soldOut,
    priceCents: own.priceCents,
    maxPerOrder: own.maxPerOrder,
    options,
  });
}

async function handleCheckout(env, request) {
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "Invalid request" }, 400); }

  const eventKey = String(body.event || "");
  const cfg = TICKETS[eventKey];
  if (!cfg) return jsonRes({ error: "Unknown event" }, 404);

  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > cfg.maxPerOrder) {
    return jsonRes({ error: `Choose between 1 and ${cfg.maxPerOrder} tickets.` }, 400);
  }

  await ensureSchema(env);
  // For a double header this is the tighter of the two shows.
  const remaining = await remainingFor(env, eventKey);
  if (remaining <= 0) return jsonRes({ error: "This is sold out.", soldOut: true }, 409);
  if (quantity > remaining) {
    return jsonRes({ error: `Only ${remaining} ticket${remaining === 1 ? "" : "s"} left.`, remaining }, 409);
  }

  const origin = new URL(request.url).origin;
  let session;
  try {
    session = await stripeApi(env, "checkout/sessions", {
      mode: "payment",
      ui_mode: "embedded_page",
      "line_items[0][quantity]": String(quantity),
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(cfg.priceCents),
      "line_items[0][price_data][product_data][name]": cfg.name,
      "line_items[0][price_data][product_data][description]": cfg.description,
      // Extensionless: Cloudflare 307s /foo.html -> /foo, and there's no reason
      // to make someone bounce through a redirect right after paying.
      return_url: `${origin}/tickets-complete?session_id={CHECKOUT_SESSION_ID}`,
      // Expire the session exactly when our seat hold does, so the two can't
      // disagree about whether those seats are still available.
      expires_at: String(Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60),
      "custom_fields[0][key]": "full_name",
      "custom_fields[0][type]": "text",
      "custom_fields[0][label][type]": "custom",
      "custom_fields[0][label][custom]": "Full name",
      "custom_fields[0][text][minimum_length]": "2",
      "custom_fields[0][optional]": "false",
      "metadata[event]": eventKey,
      "metadata[quantity]": String(quantity),
    });
  } catch (e) {
    console.log(JSON.stringify({ at: "checkout", event: eventKey, error: String(e.message) }));
    return jsonRes({ error: "Could not start checkout. Please try again." }, 502);
  }

  // Hold the seats while this checkout is open. The webhook flips the row to
  // 'paid'; if the customer wanders off, the hold expires on its own.
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO orders (ts, session_id, event, quantity, amount_cents, status) " +
        "VALUES (?, ?, ?, ?, ?, 'pending')"
    )
      .bind(Date.now(), session.id, eventKey, quantity, cfg.priceCents * quantity)
      .run();
  } catch (e) {
    console.log(JSON.stringify({ at: "hold", session: session.id, error: String(e.message) }));
  }

  return jsonRes({
    clientSecret: session.client_secret,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY,
  });
}

// The return page asks whether the payment actually landed.
async function handleCheckoutStatus(env, url) {
  const id = url.searchParams.get("session_id") || "";
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return jsonRes({ error: "Invalid session" }, 400);

  let session;
  try {
    session = await stripeApi(env, `checkout/sessions/${id}`, null, "GET");
  } catch (e) {
    return jsonRes({ error: "Could not look up that order." }, 502);
  }

  // Tell the return page which show(s) this ticket is actually for, rather
  // than letting it hardcode one event.
  const cfg = TICKETS[String(session.metadata?.event || "")];
  const shows = cfg
    ? (cfg.includes ? cfg.includes.map((k) => TICKETS[k]) : [cfg]).map((c) => ({
        name: c.name,
        when: c.when,
        doors: c.doors,
        venue: c.venue,
        address: c.address,
      }))
    : [];

  return jsonRes({
    status: session.status,
    email: session.customer_details?.email || "",
    name:
      (session.custom_fields || []).find((f) => f.key === "full_name")?.text?.value ||
      session.customer_details?.name ||
      "",
    quantity: Number(session.metadata?.quantity || 0),
    amountCents: session.amount_total ?? 0,
    bundle: !!cfg?.includes,
    shows,
  });
}

// Verify Stripe's signature by hand (see docs.stripe.com/webhooks, "Verify
// manually"): signed_payload is "<timestamp>.<raw body>", HMAC-SHA256 with the
// endpoint secret. Only the v1 scheme counts — ignoring v0 avoids a downgrade.
async function stripeSignatureValid(secret, rawBody, header) {
  if (!secret || !header) return false;

  let timestamp = "";
  const signatures = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const prefix = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (prefix === "t") timestamp = value;
    else if (prefix === "v1") signatures.push(value);
  }
  if (!timestamp || !signatures.length) return false;

  // Replay protection: Stripe's own libraries use a 5-minute tolerance.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  );
  const expected = new Uint8Array(mac);

  for (const candidate of signatures) {
    if (candidate.length !== expected.length * 2) continue;
    const bytes = new Uint8Array(expected.length);
    for (let i = 0; i < expected.length; i++) {
      bytes[i] = parseInt(candidate.slice(i * 2, i * 2 + 2), 16);
    }
    // Constant-time: never compare secrets with === .
    if (crypto.subtle.timingSafeEqual(bytes, expected)) return true;
  }
  return false;
}

// Plain, serif, no images — reads the same in every mail client and doesn't
// trip spam filters the way a heavy HTML template does.
function ticketEmail(cfg, name, quantity) {
  const first = (name || "").trim().split(/\s+/)[0] || "";
  const tix = `${quantity} ticket${quantity === 1 ? "" : "s"}`;
  const greeting = first ? `${first} — ` : "";

  // A double header covers two nights; a single show covers one.
  const shows = cfg.includes ? cfg.includes.map((k) => TICKETS[k]) : [cfg];
  const opener = cfg.includes
    ? `${greeting}you're in for both nights. ${tix} to each.`
    : `${greeting}you're in. ${tix} to ${cfg.name}.`;

  const block = (c) => [c.name, c.when, c.doors, `${c.venue}, ${c.address}`];

  const text = [opener, ""];
  shows.forEach((c) => { text.push(...block(c), ""); });
  text.push("No printed ticket needed — just give your name at the door.", "", "— Nitrate");

  const esc2 = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const shell = shows
    .map((c) => `  <p style="margin:0 0 1.2rem">
    <strong>${esc2(c.name)}</strong><br>
    ${esc2(c.when)}<br>
    ${esc2(c.doors)}<br>
    ${esc2(c.venue)}, ${esc2(c.address)}
  </p>`)
    .join("\n");

  const html = `<div style="font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.6;color:#000;max-width:480px">
  <p style="margin:0 0 1.2rem"><strong>${esc2(opener)}</strong></p>
${shell}
  <p style="margin:0 0 1.2rem">No printed ticket needed — just give your name at the door.</p>
  <p style="margin:0;color:#555">— Nitrate</p>
</div>`;

  const subject = cfg.includes
    ? "You're in — LA Double Header"
    : `You're in — ${cfg.name}`;
  return { subject, text: text.join("\n"), html };
}

// One row per show the ticket covers, so a double header lands in both tabs.
async function sendOrderToSheet(env, cfg, order) {
  if (!env.ORDERS_SHEET_URL) return;
  const shows = cfg.includes ? cfg.includes.map((k) => TICKETS[k]) : [cfg];
  for (const show of shows) {
    try {
      await fetch(env.ORDERS_SHEET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tab: show.sheetTab || show.name,
          name: order.name,
          email: order.email,
          ticketType: cfg.includes ? "Double header" : "Single",
          quantity: order.quantity,
          amount: (order.amountCents / 100).toFixed(2),
          orderId: order.sessionId,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (e) {
      console.log(JSON.stringify({ at: "sheet", tab: show.sheetTab, error: String(e.message) }));
    }
  }
}

async function sendTicketEmail(env, cfg, to, name, quantity) {
  if (!env.EMAIL || !to) return;
  const { subject, text, html } = ticketEmail(cfg, name, quantity);
  try {
    await env.EMAIL.send({ to, from: TICKET_FROM, subject, html, text });
  } catch (e) {
    // A failed email must never fail the webhook — the sale is already real.
    console.log(JSON.stringify({ at: "email", to, error: String(e.message) }));
  }
}

// Temporary helper: send yourself the confirmation email without paying for a
// ticket. Gated behind STATS_KEY, the same secret that guards /stats. Safe to
// delete once you've confirmed the email looks right.
async function handleTestEmail(env, url) {
  const key = url.searchParams.get("key") || "";
  if (!env.STATS_KEY || key !== env.STATS_KEY) {
    return new Response("Not found", { status: 404 });
  }
  const to = url.searchParams.get("to") || "";
  if (!to.includes("@")) return jsonRes({ error: "Pass ?to=you@example.com" }, 400);

  const cfg = TICKETS[url.searchParams.get("event") || "la-horror-shorts"];
  if (!cfg) return jsonRes({ error: "Unknown event" }, 404);

  const name = url.searchParams.get("name") || "Devon Tayman";
  const quantity = Number(url.searchParams.get("qty") || 2);

  // ?sheet=1 also exercises the Google Sheet path. For a double header this
  // writes one row to each show's tab, so you can check both at once.
  if (url.searchParams.get("sheet") === "1") {
    if (!env.ORDERS_SHEET_URL) return jsonRes({ error: "No ORDERS_SHEET_URL set" }, 500);
    await sendOrderToSheet(env, cfg, {
      name,
      email: to,
      quantity,
      amountCents: cfg.priceCents * quantity,
      sessionId: "cs_test_sheetcheck_" + Date.now(),
    });
    const tabs = (cfg.includes ? cfg.includes.map((k) => TICKETS[k]) : [cfg])
      .map((c) => c.sheetTab || c.name);
    return jsonRes({ sheet: true, wroteTabs: tabs, name, email: to, quantity });
  }

  if (!env.EMAIL) return jsonRes({ error: "No EMAIL binding" }, 500);
  try {
    const { subject, text, html } = ticketEmail(cfg, name, quantity);
    const res = await env.EMAIL.send({ to, from: TICKET_FROM, subject, html, text });
    return jsonRes({ sent: true, to, subject, messageId: res?.messageId ?? null });
  } catch (e) {
    return jsonRes({ sent: false, error: String(e.message) }, 502);
  }
}

async function handleStripeWebhook(env, request, ctx) {
  // Must be the unmodified body string — parsing it first breaks the signature.
  const raw = await request.text();
  const ok = await stripeSignatureValid(
    env.STRIPE_WEBHOOK_SECRET,
    raw,
    request.headers.get("stripe-signature")
  );
  if (!ok) return jsonRes({ error: "Bad signature" }, 400);

  let event;
  try { event = JSON.parse(raw); } catch { return jsonRes({ error: "Bad payload" }, 400); }

  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    // The required "Full name" custom field; fall back to whatever the wallet
    // or card supplied if it's somehow absent.
    const fullName =
      (s.custom_fields || []).find((f) => f.key === "full_name")?.text?.value ||
      s.customer_details?.name ||
      "";
    const eventKey = String(s.metadata?.event || "unknown").slice(0, 50);
    const quantity = Number(s.metadata?.quantity || 1);
    try {
      await ensureSchema(env);
      // Stripe can deliver the same event twice; the UNIQUE session_id plus
      // this upsert make a repeat delivery a no-op.
      await env.DB.prepare(
        "INSERT INTO orders (ts, session_id, event, email, name, quantity, amount_cents, status) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'paid') " +
          "ON CONFLICT(session_id) DO UPDATE SET " +
          "status = 'paid', email = excluded.email, name = excluded.name, ts = excluded.ts"
      )
        .bind(
          Date.now(),
          s.id,
          eventKey,
          s.customer_details?.email || "",
          fullName.slice(0, 200),
          quantity,
          s.amount_total ?? 0
        )
        .run();
    } catch (e) {
      // Tell Stripe to retry rather than silently losing the sale.
      console.log(JSON.stringify({ at: "webhook", session: s.id, error: String(e.message) }));
      return jsonRes({ error: "Could not record order" }, 500);
    }

    const cfg = TICKETS[eventKey];
    if (cfg) {
      const email = s.customer_details?.email || "";
      ctx.waitUntil(sendTicketEmail(env, cfg, email, fullName, quantity));
      ctx.waitUntil(
        sendOrderToSheet(env, cfg, {
          name: fullName,
          email,
          quantity,
          amountCents: s.amount_total ?? 0,
          sessionId: s.id,
        })
      );
    }
  }

  return jsonRes({ received: true });
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

  const [views, visits, clicks, tenMinRaw, hourlyRaw, dailyRaw, topPages, clickRows, countries, rsvpRows, orderRows, soldRows] =
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
      env.DB.prepare(
        "SELECT ts, event, email, name, quantity, amount_cents FROM orders " +
        "WHERE status='paid' ORDER BY ts DESC LIMIT 200"
      ).all(),
      env.DB.prepare(
        "SELECT event, sum(quantity) AS seats, sum(amount_cents) AS gross, count(*) AS n " +
        "FROM orders WHERE status='paid' GROUP BY event ORDER BY seats DESC"
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

  // Door list per show: everyone holding a seat there, including double
  // header buyers, who appear on both shows' lists.
  const doorLists = [];
  for (const key of Object.keys(TICKETS)) {
    const cfg = TICKETS[key];
    if (cfg.includes) continue;                 // bundles aren't a door
    const keys = keysHolding(key);
    const marks = keys.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT name, email, quantity, event FROM orders ` +
        `WHERE event IN (${marks}) AND status = 'paid' ORDER BY name COLLATE NOCASE`
    ).bind(...keys).all();
    const seats = rows.results.reduce((n, r) => n + (r.quantity || 0), 0);
    doorLists.push({ key, cfg, rows: rows.results, seats, left: await remainingFor(env, key) });
  }

  // Ticket totals
  const money = (cents) => "$" + (cents / 100).toFixed(2);
  const totalSeats = soldRows.results.reduce((sum, r) => sum + (r.seats || 0), 0);
  const totalGross = soldRows.results.reduce((sum, r) => sum + (r.gross || 0), 0);

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
  <div>Link clicks<b>${clicks}</b></div>
  <div>Tickets sold<b>${totalSeats}</b></div>
  <div>Gross<b>${money(totalGross)}</b></div>
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

<h2>Ticket sales</h2>
<table>
  <tr><th>Show</th><th class="num">Orders</th><th class="num">Seats</th><th class="num">Gross</th></tr>
  ${soldRows.results.length
    ? soldRows.results.map(r =>
        `<tr><td>${esc(r.event)}</td><td class="num">${r.n}</td><td class="num">${r.seats}</td><td class="num">${money(r.gross || 0)}</td></tr>`
      ).join("")
    : `<tr><td colspan="4" style="color:#999">no tickets sold yet</td></tr>`
  }
</table>

${doorLists.map((d) => `
<h2>Door list &mdash; ${esc(d.cfg.name)}</h2>
<p style="margin:-0.4rem 0 0.75rem;color:#999;font-size:.85rem">
  ${d.seats} of ${d.cfg.capacity} seats sold &middot; ${d.left} left
</p>
<table>
  <tr><th>Name</th><th>Email</th><th class="num">Qty</th><th>Ticket</th></tr>
  ${d.rows.length
    ? d.rows.map((r) => {
        const isBundle = r.event !== d.key;
        return `<tr><td>${esc(r.name || "—")}</td><td>${esc(r.email || "")}</td>` +
               `<td class="num">${r.quantity}</td>` +
               `<td${isBundle ? ' style="font-style:italic"' : ""}>${isBundle ? "Double header" : "Single"}</td></tr>`;
      }).join("")
    : `<tr><td colspan="4" style="color:#999">nobody yet</td></tr>`}
</table>
`).join("")}

<h2>Orders</h2>
<table>
  <tr><th>Date</th><th>Name</th><th>Email</th><th>Show</th><th class="num">Qty</th><th class="num">Paid</th></tr>
  ${orderRows.results.length
    ? orderRows.results.map(r => {
        const d = new Date(r.ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
        return `<tr><td style="color:#999;white-space:nowrap">${d}</td><td>${esc(r.name || "—")}</td><td>${esc(r.email || "")}</td><td>${esc(r.event)}</td><td class="num">${r.quantity}</td><td class="num">${money(r.amount_cents || 0)}</td></tr>`;
      }).join("")
    : `<tr><td colspan="6" style="color:#999">no orders yet</td></tr>`
  }
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

    // Ticketing.
    if (url.pathname === "/api/tickets-remaining" && request.method === "GET") {
      return handleTicketsRemaining(env, url);
    }
    if (url.pathname === "/api/checkout" && request.method === "POST") {
      return handleCheckout(env, request);
    }
    if (url.pathname === "/api/checkout-status" && request.method === "GET") {
      return handleCheckoutStatus(env, url);
    }
    if (url.pathname === "/api/test-email" && request.method === "GET") {
      return handleTestEmail(env, url);
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
