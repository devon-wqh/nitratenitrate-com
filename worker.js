// Workers entry point. Cloudflare serves any matching static file directly,
// so this script only runs for paths with no matching asset (e.g. /go/*).
const REDIRECTS = {
  "/go/tickets-iii":
    "https://www.slipperroom.com/event-details/guest-event-nitrate-iii-film-screening-july-7",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const dest = REDIRECTS[url.pathname];

    if (dest) {
      // Count the click server-side, then redirect. Counting here works even
      // when JS is blocked or an in-app browser cancels in-flight requests.
      const name = url.pathname.slice("/go/".length); // e.g. "tickets-iii"
      try {
        env.TICKETS?.writeDataPoint({
          blobs: [
            name,
            request.headers.get("referer") || "",
            request.headers.get("user-agent") || "",
            request.cf?.country || "",
          ],
          doubles: [1],
          indexes: [name],
        });
      } catch (e) {
        // never let analytics failures block the redirect
      }
      return Response.redirect(dest, 302);
    }

    // Everything else: hand back to the static assets (also handles 404s).
    return env.ASSETS.fetch(request);
  },
};
