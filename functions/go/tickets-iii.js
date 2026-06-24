// Counts a click then redirects to the Slipper Room ticket page.
// Counting happens server-side, so it works even when JS is blocked or the
// in-app browser cancels in-flight requests on navigation.
const DEST = "https://www.slipperroom.com/event-details/guest-event-nitrate-iii-film-screening-july-7";

export async function onRequestGet({ request, env }) {
  // env.TICKETS is the Analytics Engine binding (configured in the Pages
  // dashboard). Optional chaining keeps the redirect working even if the
  // binding isn't set up yet.
  try {
    env.TICKETS?.writeDataPoint({
      blobs: [
        "tickets-iii",
        request.headers.get("referer") || "",
        request.headers.get("user-agent") || "",
        request.cf?.country || "",
      ],
      doubles: [1],
      indexes: ["tickets-iii"],
    });
  } catch (e) {
    // never let analytics failures block the redirect
  }
  return Response.redirect(DEST, 302);
}
