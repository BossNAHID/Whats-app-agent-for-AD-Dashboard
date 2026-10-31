# CarryBee WhatsApp Bridge (OpenWA + Vercel + Supabase Edition)

Sends remarks from the **CarryBee AD Dashboard** into mapped WhatsApp groups automatically — powered by:
1. **Vercel** — permanent HTTPS front-end (`/api/send-remark`, `/admin`, `/qr/:accountId`, `/pair/:accountId`) so your AD Dashboard URL never has to change.
2. **Supabase PostgreSQL (`public.carrybee_kv`)** — permanent cloud storage for WhatsApp accounts, Merchant group mappings, KAM routing, and your active OpenWA Gateway URL.
3. **[OpenWA (`open-wa.org`)](https://www.open-wa.org/#quickstart)** (`@rmyndharis/openwa`) — Docker WhatsApp Web engine that eliminates Baileys Signal `SenderKey` *"Waiting for this message"* group decryption issues.

---

## Architecture: How Vercel + Supabase + OpenWA Work Together

```
[ CarryBee AD Dashboard ]
           │  POST /api/send-remark  (permanent HTTPS URL)
           ▼
[ Vercel Serverless Bridge ] ◄────► [ Supabase PostgreSQL (public.carrybee_kv) ]
           │                        (Accounts, Group Mappings, KAM Mappings, Gateway URL)
           │  OpenWA SDK (/openwa)
           ▼
[ OpenWA Docker Engine ]
  • Today: Render Free Docker (no card needed) or local Docker + Cloudflare Tunnel
  • Permanent: XeonBD Ubuntu KVM VPS (`docker compose up -d --build`)
```

Because Vercel Serverless Functions cannot hold persistent 24/7 WhatsApp TCP/Chromium processes on their own, **OpenWA runs inside Docker** and links automatically to your Vercel + Supabase bridge!
- When you move from Render Free Docker to your XeonBD KVM VPS in a few days, **your AD Dashboard URL (`https://...vercel.app`) and all Supabase mappings stay 100% untouched**.

---

## Step 1 — Permanent Front-End on Vercel + Supabase

Set these 3 environment variables on your Vercel project:
- `API_KEY` — your master CarryBee Bridge secret key (used by AD Dashboard and `/admin`)
- `SUPABASE_URL` — `https://<project-ref>.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — your Supabase `service_role` secret key

*(Optional fallback: `TURSO_DB_URL` + `TURSO_DB_TOKEN` are still supported if `SUPABASE_URL` is omitted.)*

---

## Step 2A — Run the OpenWA Engine on Render Free Docker (Temporary — No Card Needed)

1. In Render Dashboard, click **New + → Web Service** (or **Blueprint**) and connect this GitHub repo.
2. **Important:** Choose **Language / Runtime = `Docker`** and **Instance Type = `Free`** ($0, no card needed; `carrybee-start.sh` auto-detects 512 MB RAM and selects OpenWA's lightweight engine so 3+ accounts fit safely).
3. Under **Environment**, add the exact same:
   - `API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Deploy! On boot, the Render Docker container **automatically registers its `RENDER_EXTERNAL_URL/openwa` + OpenWA API key inside Supabase**, so your Vercel `/admin` connects immediately with zero manual steps!

---

## Step 2B — Move OpenWA Engine to Your Ubuntu KVM VPS (Permanent 3 GB RAM Setup)

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
nano .env
# Set:
#   API_KEY=...
#   SUPABASE_URL=...
#   SUPABASE_SERVICE_ROLE_KEY=...
#   PUBLIC_GATEWAY_URL=http://YOUR_VPS_IP:3000

# 4. Build & start OpenWA (whatsapp-web.js Chromium) + CarryBee Bridge
docker compose up -d --build
```

On boot, your VPS automatically updates `openwa-gateway-config` in Supabase to `http://YOUR_VPS_IP:3000/openwa` (or you can paste/test any OpenWA URL manually in **Vercel `/admin` → Section 0**). Scan `/qr/<accountId>` once per WhatsApp number, and delete the temporary Render service!

---

## Wiring into the CarryBee AD Dashboard

Point your AD Dashboard permanently to your **Vercel URL**:

```js
await fetch('https://carrybee-whatsapp-bridge.vercel.app/api/send-remark', {
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

| Method | Path                               | Purpose                                                             |
| ------ | ---------------------------------- | ------------------------------------------------------------------- |
| GET    | `/`                                | Live status page for OpenWA Gateway + all WhatsApp accounts         |
| GET    | `/admin`                           | Manage Gateway URL, WhatsApp accounts, groups, and KAM mappings     |
| GET    | `/qr/:accountId`                   | Scan QR code (generated by OpenWA) to connect an account            |
| GET    | `/pair/:accountId`                 | Phone pairing-code page for a specific account                      |
| GET    | `/api/health`                      | Health check (`bridge`, `storage`, and `openwa` readiness)          |
| GET    | `/api/gateway-config`              | Check active OpenWA Gateway URL & storage backend (master key only) |
| POST   | `/api/gateway-config`              | Save & test OpenWA Gateway URL + API key in Supabase (master key)   |
| GET    | `/api/status`                      | JSON connection status for every account                            |
| GET    | `/api/status/:accountId`           | JSON connection status for one account                              |
| GET    | `/api/accounts`                    | List all accounts (needs `x-api-key`)                               |
| POST   | `/api/accounts`                    | Add a new account `{ "label": "..." }` (needs `x-api-key`)          |
| POST   | `/api/accounts/:accountId/restart` | Restart an account's OpenWA session (needs `x-api-key`)             |
| DELETE | `/api/accounts/:accountId`         | Unlink & remove an account (needs `x-api-key`)                      |
| GET    | `/api/groups/:accountId`           | List all WhatsApp groups + `@g.us` IDs for an account (`x-api-key`) |
| GET    | `/api/mapping`                     | View dashboard group name → WhatsApp group mappings (`x-api-key`)   |
| POST   | `/api/mapping`                     | Save a group mapping `{ dashboard_name, group_id, account_id }`     |
| DELETE | `/api/mapping/:dashboard_name`     | Remove a group mapping (`x-api-key`)                                |
| GET    | `/api/kam-mapping`                 | View KAM email → sending WhatsApp account mappings (`x-api-key`)    |
| POST   | `/api/kam-mapping`                 | Save a KAM mapping `{ email, account_id }` (`x-api-key`)            |
| DELETE | `/api/kam-mapping/:email`          | Remove a KAM mapping (`x-api-key`)                                  |
| POST   | `/api/send-remark`                 | Send a remark to its mapped WhatsApp group via OpenWA (`x-api-key`) |

---

Powered by NAHID · Engine by [OpenWA](https://www.open-wa.org)
