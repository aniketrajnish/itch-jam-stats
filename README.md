# jam-stats

check [makra.games/jam-stats](https://makra.games/jam-stats/)

## deployment

this repo is set up for:

- github pages serving the static frontend
- a cloudflare worker route serving `https://makra.games/api/*`

that keeps the app same-origin in production, so `index.html` can leave `jam-stats-api-base` empty.

## cloudflare worker

worker entrypoint:

- `worker.mjs`

wrangler config:

- `wrangler.toml`

route:

- `makra.games/api/*`

deploy it with:

```powershell
npm run cf:deploy
```

before the first deploy:

1. run `npx wrangler login`
2. make sure `makra.games` stays proxied through cloudflare
3. keep the route in `wrangler.toml` as `makra.games/api/*`

## github pages

github pages only needs to publish the static files:

- `index.html`
- `app.js`
- `logo.png`

the frontend script is cache-busted in `index.html`, so new deploys pick up the current `app.js`.

## local development

local node api:

```powershell
npm start
```

local worker dev:

```powershell
npm run cf:dev
```

if you serve the frontend locally from another origin while using the worker or node api, set `jam-stats-api-base` in `index.html` to that local api origin.

## cost

for a small personal site this should normally stay free:

- github pages for the static site
- cloudflare worker free tier for the api route

the main recurring cost remains your existing cloudflare domain registration.
