# mafia_2.0

Real-time Mafia lobby app built with Express and Socket.IO.

## Run locally

```bash
npm install
npm start
```

App URLs:

- Home: `http://localhost:3000/`
- Join page: `http://localhost:3000/join.html`
- Lobby page: `http://localhost:3000/lobby.html`
- Healthcheck: `http://localhost:3000/health`

## Test the multiplayer flows

```bash
npm test
```

The integration test suite covers:

- QR invite URLs using the public deployment domain
- multiplayer create/join/assign/reset flows
- duplicate-name rejection
- reconnect-safe player restores
- storyteller refresh restores
- grace-period cleanup for disconnected players
- final lobby closure when the storyteller does not return

## Deploy to Railway

This repo is preconfigured for Railway with `railway.json`:

- builder: `RAILPACK`
- start command: `node server.js`
- healthcheck path: `/health`
- restart policy: `ON_FAILURE`
- QR join links use `RAILWAY_PUBLIC_DOMAIN` automatically on Railway

### GitHub deploy

1. Push this repo to GitHub.
2. Create a new Railway project.
3. Choose `Deploy from GitHub repo`.
4. Select this repository.
5. Generate a public domain in the service `Networking` tab.
6. Verify `/health` returns HTTP `200`.

### CLI deploy

```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway domain
```

## Notes

- Railway injects `PORT`, and the app already listens on `process.env.PORT || 3000`.
- If you later add a custom domain or want to override the detected base URL, set `PUBLIC_APP_URL`.
- Sessions are reconnect-safe across browser refreshes, but lobby state is still stored in memory.
- Active lobbies are still lost on server restart or redeploy until persistent storage is added.
