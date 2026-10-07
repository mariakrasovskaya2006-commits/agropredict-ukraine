# AgroPredict Climate MCP 0.2.0 — independent server

This version runs independently of ChatGPT. No ChatGPT login, workspace, plugin or OAuth is needed to use the public demonstration.

There are two addresses after deployment:

- `/`: a browser page. Enter coordinates and historical dates, click **Calculate comparison**, and inspect actual NASA POWER data, sources and coverage.
- `/mcp`: the Streamable HTTP endpoint for an AI/MCP client. A browser visiting this address is redirected to the demo page; an MCP client uses POST requests.

## Local run

Node.js 22 or newer; verified with Node 24. No packages to install.

```sh
npm start
```

Open `http://127.0.0.1:8787` in a browser on the machine running the server. Connect an MCP client to `http://127.0.0.1:8787/mcp` on that same machine. These local addresses are not public links and cannot be sent to Chris as remote endpoints.

## Render deployment

`render.yaml` describes a Node web service with a free plan, a health check and explicitly enabled public read-only demo mode. Link a repository containing this source to Render and deploy it. The service obtains its HTTPS origin from `RENDER_EXTERNAL_URL` and binds to the provided `PORT` on `0.0.0.0`. No ChatGPT-hosted repository or application is required.

Render accounts, connected source and publishing access are needed to create the remote service. This package is prepared for deployment; it is not evidence that an external service has already been published.

The free plan suspends an idle service after 15 minutes and its next startup can take about a minute. Open the demo before a workshop to verify the service and source availability. A paid service is optional and requires the owner's choice; none has been created.

Official references:
- https://render.com/docs/web-services
- https://render.com/docs/free
- https://render.com/docs/environment-variables

## Hosting elsewhere

Run `node server.mjs` behind an HTTPS reverse proxy. Configure `AGROPREDICT_HOST=0.0.0.0`, `AGROPREDICT_PORT`, and `AGROPREDICT_PUBLIC_ORIGIN` to the exact HTTPS origin. Forward the public Host header. Select either:

- `AGROPREDICT_PUBLIC_DEMO=true`: anonymous read-only tools for public demo coordinates, without stored farm records.
- `AGROPREDICT_MCP_TOKEN`: a random secret of at least 32 characters; MCP clients send `Authorization: Bearer <secret>`. This secures the MCP endpoint separately from ChatGPT. The sample browser calculator is intended for public demo mode; it does not embed this secret.

A remote bind without a known HTTPS origin and an explicit access mode is rejected. The service limits request size, concurrent work and request rate. Use the calling platform's own farm permissions if extending this into a private farm application.

## Tools and evidence

`get_climate_summary`: daily temperature (T2M), corrected precipitation (PRECTOTCORR) and relative humidity (RH2M), summaries, per-parameter coverage and source provenance.

`compare_climate_history`: the same calendar window in 3–5 earlier years. Temperature differences are C; rainfall is compared as accumulated mm and percentage; humidity differences are percentage points. A comparison is unavailable for any parameter without complete coverage in every window. February 29 is excluded in every comparison window. No fabricated values or forecasts are provided.

Source URLs, UTC time standard, retrieval timestamps, NASA API version and response SHA-256 accompany the output. Grid-cell estimates are not farm sensor readings. A short selected reference is not a standard 30-year climatological normal. FarmID is not connected or verified.

Historical dates: from 1981, 1–92 inclusive days within one year. Use public demo coordinates only. The sample location is not an identified farm.

Transport: Streamable HTTP with JSON responses. MCP protocol revisions `2025-11-25`, `2025-06-18`, `2025-03-26`. Stateless; no SSE subscription. Use initialize, notifications/initialized, tools/list and tools/call. The `/demo-guide.json` page and `agropredict://demo-guide` MCP resource contain sample arguments.

Verification:

```sh
npm test
npm run test:live
```

The independent HTTP server was also tested with official MCP TypeScript SDK 1.32.1: connection, tool discovery, a real NASA call and clean shutdown. The demo page, browser redirect and lack of ChatGPT authentication were checked. The independently hosted public URL and FarmID client remain unverified until an external deployment is made.
