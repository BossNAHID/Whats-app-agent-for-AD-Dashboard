# CarryBee WhatsApp Bridge (OpenWA Edition)

Sends remarks from the **CarryBee AD Dashboard** into mapped WhatsApp groups automatically — powered by **[OpenWA (`open-wa.org`)](https://www.open-wa.org/#quickstart)** and its official `@rmyndharis/openwa` SDK instead of direct Baileys sockets.

## Why OpenWA?

- **Fixes *"Waiting for this message"* in groups:** OpenWA runs `whatsapp-web.js` (real WhatsApp Web inside headless Chromium) by default, so WhatsApp's own web client manages Signal `SenderKey` group encryption and retry receipts natively.
- **Zero AD Dashboard changes:** Keeps the exact same `/api/send-remark`, `/admin`, `/qr/:accountId`, `/pair/:accountId`, and Turso group & KAM mappings.
- **Seamless Render → KVM VPS move:** Because all group mappings, KAM email mappings, and account labels live in **Turso**, you can run on **Render** for a few days right now and move to your **Ubuntu KVM VPS** later without re-entering a single mapping.

---

## Option A — Run on Render Right Now (Temporary for a Few Days)

This repo includes an all-in-one `Dockerfile` + `render.yaml` that runs **both OpenWA Gateway and CarryBee Bridge inside one container**.

> **Important Render sizing note:** Because OpenWA launches headless Chromium (`whatsapp-web.js`), select at least Render's **Standard (2 GB RAM)** plan and attach a **Render Disk** mounted at `/app/data` (10 GB). Render bills **hourly (prorated)**, so running it for a few days and deleting it once your VPS is live only charges for the hours used. *(512 MB Starter instances will run out of memory when Chromium opens WhatsApp Web.)*

### Deploy via Render Blueprint (1-click) or Existing Service:
1. Push this branch / merge to `main` on GitHub.
2. In Render Dashboard:
   - **New setup:** Click **New + → Blueprint**, select this repo, and enter `API_KEY`, `TURSO_DB_URL`, and `TURSO_DB_TOKEN`.
   - **Updating an existing Render Web Service:**
     1. Go to **Settings → Build & Deploy** and set **Language / Runtime** to **`Docker`**.
     2. Set **Instance Type** to **`Standard` (2 GB RAM)**.
     3. Go to **Disks → Add Disk**: Name `openwa-data`, Mount Path **`/app/data`**, Size `10 GB`.
     4. Under **Environment**, keep your existing `API_KEY`, `TURSO_DB_URL`, `TURSO_DB_TOKEN` and add `NODE_ID=carrybee-openwa-1` and `AUTO_START_SESSIONS=true`.
3. Once deployed, **unlink the old Baileys device** on each phone (**WhatsApp → Linked devices → Log out**), then open `https://your-render-url.onrender.com/admin` and scan each account's `/qr/<accountId>` page.

---

## Option B — Move to Your Ubuntu KVM VPS (Permanent Setup)

When your **Ubuntu 22.04 / 24.04 KVM VPS** (e.g. XeonBD `VPS 2022v2` — 2 vCPU, 3 GB RAM) is ready, SSH in as `root` and run:

```bash
# 1. Install Docker + Compose plugin
apt update && apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sh

# 2. Add 2 GB swap file (extra safety headroom for Chromium spikes)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 3. Clone this repo & configure .env
git clone https://github.com/BossNAHID/Whats-app-agent-for-AD-Dashboard.git
cd Whats-app-agent-for-AD-Dashboard
cp .env.example .env
nano .env   # Paste your same API_KEY, TURSO_DB_URL, and TURSO_DB_TOKEN

# 4. Build & start OpenWA + CarryBee Bridge in the background
docker compose up -d --build
```

Then:
1. Open `http://YOUR_VPS_IP:3000/admin` — all your existing accounts, group mappings, and KAM mappings from Turso will already be loaded!
2. Scan `/qr/<accountId>` once for each WhatsApp number.
3. Update the bridge URL in your AD Dashboard to `http://YOUR_VPS_IP:3000` (or put a free Cloudflare / Nginx / Caddy HTTPS domain in front of port `3000`), then delete the temporary Render service.

---

## Option C — Local Development / Split Hosting (Bridge on Vercel + External OpenWA)

If you run OpenWA separately (for example `docker run -p 2785:2785 -v ./openwa-data:/app/data ghcr.io/rmyndharis/openwa:latest`) and want to run just the stateless CarryBee Bridge locally or on Vercel:

```bash
npm install
cp .env.example .env
# Set API_KEY, TURSO_DB_URL, TURSO_DB_TOKEN, OPENWA_BASE_URL, and OPENWA_API_KEY
npm start
```

---

## Wiring into the CarryBee AD Dashboard

Unchanged from v2 — your dashboard calls `POST /api/send-remark`:

```js
await fetch('https://your-bridge-host/api/send-remark', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'YOUR_API_KEY'
  },
  body: JSON.stringify({
    group_name: 'CarryBee Issue Group || NN1', // matched case/whitespace-insensitively
    message: remarkText,
    kam_email: 'nuruzzaman.nahid@carrybee.com' // optional: routes via that KAM's mapped WA number
  })
});
```

---

## Endpoints Summary

| Method | Path                             | Purpose                                                             |
| ------ | -------------------------------- | ------------------------------------------------------------------- |
| GET    | `/`                              | Live status page for OpenWA Gateway + all WhatsApp accounts         |
| GET    | `/admin`                         | Manage accounts, WhatsApp groups, group mappings, and KAM mappings  |
| GET    | `/qr/:accountId`                 | Scan QR code (generated by OpenWA) to connect an account            |
| GET    | `/pair/:accountId`               | Phone pairing-code page for a specific account                      |
| GET    | `/api/health`                    | Health check for Render / Docker (`bridge` + `openwa` readiness)    |
| GET    | `/api/status`                    | JSON connection status for every account                            |
| GET    | `/api/status/:accountId`         | JSON connection status for one account                              |
| GET    | `/api/accounts`                  | List all accounts (needs `x-api-key`)                               |
| POST   | `/api/accounts`                  | Add a new account `{ "label": "..." }` (needs `x-api-key`)          |
| POST   | `/api/accounts/:accountId/restart` | Restart an account's OpenWA session (needs `x-api-key`)           |
| DELETE | `/api/accounts/:accountId`       | Unlink & remove an account (needs `x-api-key`)                      |
| GET    | `/api/groups/:accountId`         | List all WhatsApp groups + `@g.us` IDs for an account (`x-api-key`) |
| GET    | `/api/mapping`                   | View dashboard group name → WhatsApp group mappings (`x-api-key`)   |
| POST   | `/api/mapping`                   | Save a group mapping `{ dashboard_name, group_id, account_id }`     |
| DELETE | `/api/mapping/:dashboard_name`   | Remove a group mapping (`x-api-key`)                                |
| GET    | `/api/kam-mapping`               | View KAM email → sending WhatsApp account mappings (`x-api-key`)    |
| POST   | `/api/kam-mapping`               | Save a KAM mapping `{ email, account_id }` (`x-api-key`)            |
| DELETE | `/api/kam-mapping/:email`        | Remove a KAM mapping (`x-api-key`)                                  |
| POST   | `/api/send-remark`               | Send a remark to its mapped WhatsApp group via OpenWA (`x-api-key`) |

---

Powered by NAHID · Engine by [OpenWA](https://www.open-wa.org)
