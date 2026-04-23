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
- Lobby state is stored in memory, so active lobbies are lost on restart or redeploy.
