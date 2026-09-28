# Self-hosting on Railway, Coolify and Dokploy

OpenGeo deploys to any Docker host. This page covers the one-click PaaS paths.

For the two primary paths see [Docker](./SELF_HOSTING_DOCKER.md) (personal use) and
[Cloudflare](./SELF_HOSTING_CLOUDFLARE.md) (team / internet-facing, free plan).

---

## What you need

|                      |                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **A DataForSEO key** | From [app.dataforseo.com/register](https://app.dataforseo.com/register) → **API Access** tab. It gives you a base64 `login:password`. |
| **Or none at all**   | Set `DEMO_MODE=true` and explore with seeded data first. Add a key when you're ready.                                                 |

Everything else has a working default. `AUTH_MODE=local_noauth` is fine for a trial; use `hosted`
with a `BETTER_AUTH_SECRET` (32+ random characters) for anything real.

---

## Railway

1. **New Project → Deploy from GitHub Repo** → pick `RatioArtificiosa/Open-GEO`.
2. Railway detects [`railway.json`](../railway.json) automatically: Dockerfile build,
   `docker-entrypoint.sh` as the start command, health check on `/`.
3. **Variables** tab → add:

   ```
   DATAFORSEO_API_KEY=<base64 login:password>
   AUTH_MODE=local_noauth        # or: hosted
   BETTER_AUTH_SECRET=<32+ chars>  # required for hosted auth
   DEMO_MODE=false
   ```

4. **Deploy.** Railway assigns a public URL.

**Persistent storage:** add a volume mounted at `/app/data`, or the SQLite database is lost on every
redeploy. (If you use Postgres instead, set `DATABASE_URL` and no volume is needed.)

---

## Coolify

1. **New Resource → Deploy from GitHub** → this repo.
2. **Build Pack:** Dockerfile · **Dockerfile:** `Dockerfile.selfhost` · **Context:** `.`
3. **Health check path:** `/`
4. **Environment:** the same variables as above.
5. **Persistent volume:** mount a host directory at `/app/data` so data survives redeploys.

A ready-to-adapt stack is in [`deploy.docker-compose.yml`](../deploy.docker-compose.yml) — it is
plain Compose, so it works in Coolify, Dokploy, Portainer, or anywhere you already run containers.

---

## Dokploy

1. **Create Application → Git** → this repo, branch `main`.
2. **Build Type:** Dockerfile · **Dockerfile Path:** `Dockerfile.selfhost`
3. **Health check path:** `/`
4. Add the environment variables, and a **volume** at `/app/data`.

---

## Verifying the deployment

```bash
curl -s https://your-deployment.example/ | head -20
```

You should see the OpenGeo interface. Then, to confirm DataForSEO is wired:

```bash
# In your deployment's environment, the key must be set:
#   DATAFORSEO_API_KEY
# A missing key shows a clear error rather than a blank dashboard.
```

If you started with `DEMO_MODE=true` and everything looks right, switch it to `false`, add the key,
and redeploy. You keep the same database.

---

## Troubleshooting

| Symptom                                                     | Cause                              | Fix                                                    |
| ----------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| `Missing required environment variable: DATAFORSEO_API_KEY` | No key set                         | Add it, or set `DEMO_MODE=true` to explore first       |
| App restarts in a loop                                      | DB volume not mounted              | Mount a persistent volume at `/app/data`               |
| Port unreachable                                            | Platform assigned a different port | The app reads `PORT`; Railway/Coolify set it for you   |
| Data disappears on redeploy                                 | No volume                          | Same as above — mount `/app/data`                      |
| Live data returns 404s/errors                               | Wrong region or auth mode          | `AUTH_MODE=hosted` + `BETTER_AUTH_SECRET` for real use |

---

## Which path should I pick?

| Situation                                            | Use                                     |
| ---------------------------------------------------- | --------------------------------------- |
| Trying OpenGeo on your laptop                        | **Docker**                              |
| A team, several devices, internet-facing, free       | **Cloudflare**                          |
| You already deploy apps on a PaaS and want one click | **Railway / Coolify / Dokploy**         |
| You need scale and a managed database                | **Railway + Postgres** (`DATABASE_URL`) |

---

See also: [Docker](./SELF_HOSTING_DOCKER.md) · [Cloudflare](./SELF_HOSTING_CLOUDFLARE.md) ·
[DataForSEO key](./DATAFORSEO_API_KEY.md) · [Methodology](./METHODOLOGY.md)
