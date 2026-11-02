/**
 * Handles GET /api/health, declared in octane.config.ts.
 *
 * A ServerRoute returns a Response, so this never renders and never ships to
 * the browser — it is the place for an API endpoint, a webhook, or a form
 * action.
 */
export function health(): Response {
  return Response.json({ status: "ok" });
}
