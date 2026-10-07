# AgroPredict full website + independent MCP

The complete website is ported from published Sites commit `9f4b9417835b1643d326ef20a15483c83b95b6c1`, preserving all pages, languages, crop references, map, climate calculations, SoilGrids APIs, economics and feedback. The original Python prototype remains in the repository root. This implementation lives on branch `full-web-render`, directory `web`.

Routes: `/`, `/analysis`, `/tools`, `/tools/climate`, `/tools/soil`, `/tools/growing-season`, `/tools/rainfall`, `/tools/economics`, `/tools/compare-crops`, `/tools/crop-reference`, `/about`, `/research`. The original standalone demo is retained at `/climate-demo`. MCP remains `/mcp`; `/demo-guide.json` documents its two read-only tools. Website pages and MCP do not require a ChatGPT account.

## Run

Node 24+: `npm ci && npm run build && npm start`. Local development uses SQLite. `npm test` verifies crop calculations, every website route, MCP discovery, atomic feedback storage, migration idempotency and origin rejection.

## Render

Use the existing free web service with branch `full-web-render`, root directory `web`, build `npm ci && npm run build`, start `node server.mjs`, health path `/health`. Keep `NODE_VERSION=24.19.0` and `AGROPREDICT_PUBLIC_DEMO=true`.

For the staged transfer, `AGROPREDICT_FEEDBACK_ORIGIN=https://agropredict.app` forwards only feedback and anonymous analytics writes to the existing public API. Data stay in the existing database; no feedback is included in GitHub. All other website functions run on Render independently. Do not move `agropredict.app` to Render while this fallback is enabled, because it would create a forwarding loop.

## Complete database cutover

Configure `DATABASE_URL` with a durable PostgreSQL connection on Render, then run `npm run import:data -- /absolute/private/export.json` with the same target connection. Import is transactional per batch and idempotent by original IDs, retaining text timestamps. Verify counts and feedback submission, then remove `AGROPREDICT_FEEDBACK_ORIGIN`. The app prefers PostgreSQL when both variables exist. Database credentials must remain in Render secret environment settings and must never be committed.

Render local files are ephemeral; production SQLite is rejected. Render's free PostgreSQL expires after 30 days, so it is not configured as the long-term store. A paid database needs the owner's explicit approval.

The old public website remains live until the independent copy and database cutover are verified. Browser-saved language and coordinates are origin-scoped and do not automatically move to a new address. To keep the existing public domain, add its HTTPS origins to `AGROPREDICT_ADDITIONAL_ORIGINS` and configure Render custom domains after database cutover.
