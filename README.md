# CarryBee WhatsApp Bridge

Sends a message to a specific WhatsApp group automatically whenever a KAM saves a remark on the dashboard — using one or more WhatsApp numbers, connected via `Baileys`.

## ⚠️ Important — read before using

- Baileys automates WhatsApp Web. It is **not** an official WhatsApp/Meta API, and using it goes against WhatsApp's Terms of Service. There is a real risk (usually low if usage stays moderate and human-like, but non-zero) that a connected number gets flagged, rate-limited, or banned.
- Each account connects to whichever number scans its QR code (or enters its pairing code). Every message sent through that account uses that number's identity.
- It needs a server that **stays running continuously**, with the sessions persisted in Turso (see Setup below). If Turso is wiped, every connected account will need to reconnect.
- If a number ever gets banned, there's no official appeal path the way there is with the Business API.

If you want zero risk long-term, the alternative is manually pasting remarks into WhatsApp, or later moving to the official WhatsApp Business API for 1:1 merchant messages (note: the official API does **not** support posting into groups at all, only individual chats).

## Multiple WhatsApp accounts

[#multiple-whatsapp-accounts](#multiple-whatsapp-accounts)

The bridge now supports connecting **more than one WhatsApp number** at once — useful when different KAMs each need to send from their own number into their own groups, since only an account that's actually a member of a WhatsApp group can post into it.

- There's always one **default** account (the original one — if you're upgrading from a single-account setup, it keeps using the exact same stored session, so it does **not** need to re-scan a QR code).
- You can add more accounts from `/admin` (or `POST /api/accounts`), each with its own label, its own QR/pairing-code page, and its own independent connection.
- Each dashboard→group mapping now records **which account** should send to that group. A KAM's remark goes out through whichever number is mapped to that group.
- Removing an account only wipes that account's own session — it never touches any other account's connection or the saved group mappings.

## What it does

[#what-it-does](#what-it-does)

1. You run this service. For each WhatsApp account you want connected, you open its QR page once (like linking WhatsApp Web) or use a pairing code instead.
2. For each dashboard "group name", you tell the bridge which real WhatsApp group ID it maps to **and** which connected account should send there (one-time mapping, editable anytime).
3. Your dashboard calls one HTTP endpoint whenever a KAM saves a remark. This service sends that remark into the matching WhatsApp group, via the mapped account.

## Setup

[#setup](#setup)

```
npm install
cp .env.example .env
# edit .env: set API_KEY to something private, and your Turso credentials
npm start
```

Open `http://localhost:3000/admin` (or your deployed URL + `/admin`) to add accounts, connect them, and set up group mappings — all from one page. Or use `http://localhost:3000/` for a quick read-only status view of every connected account.

## Connecting an account

[#connecting-an-account](#connecting-an-account)

1. From `/admin`, add a new account with a label (e.g. "Asif's CarryBee number"), or use the pre-existing default account.
2. Open its `/qr/<accountId>` link and scan it with: **WhatsApp on your phone → Settings → Linked devices → Link a device** — or use `/pair/<accountId>?phone=YOURNUMBER` to type a code instead.
3. Once connected, `/admin` shows that account as "Connected" along with the WhatsApp name it logged in as.

## Map your dashboard group names to real WhatsApp groups

[#map-your-dashboard-group-names-to-real-whatsapp-groups](#map-your-dashboard-group-names-to-real-whatsapp-groups)

Easiest via `/admin`: pick the account that's a member of the target group, load its groups, and save the mapping from the dropdown. Or via the API:

1. Make sure the WhatsApp account you want to send from is already a member of the target group(s).
2. Call:

```
curl http://localhost:3000/api/groups/YOUR_ACCOUNT_ID -H "x-api-key: YOUR_API_KEY"
```

This lists every group that account is in, with its `id` (looks like `1203630xxxxxxxxx@g.us`).

3. Map a dashboard group name to that ID and account:

```
curl -X POST http://localhost:3000/api/mapping \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dashboard_name": "CarryBee Issue Group || NN1", "group_id": "1203630xxxxxxxxx@g.us", "account_id": "YOUR_ACCOUNT_ID"}'
```

Omitting `account_id` maps it to the default account, for backwards compatibility.

4. Repeat for every group name your dashboard uses. You can also remove a mapping with `DELETE /api/mapping/:dashboard_name`.

## Wiring it into your dashboard

[#wiring-it-into-your-dashboard](#wiring-it-into-your-dashboard)

Wherever your dashboard currently saves a KAM's remark (the code that writes it to Sheets/Turso), add one more call right after — this part is unchanged, the bridge figures out which account to use internally based on the mapping:

```
await fetch('https://your-bridge-url.onrender.com/api/send-remark', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'YOUR_API_KEY'
  },
  body: JSON.stringify({
    group_name: 'CarryBee Issue Group || NN1',  // exactly as shown on your dashboard
    message: remarkText,
    ticket_id: 'CB-0816-00856',                  // optional, gets bolded at the top
    kam_name: 'Nuruzzaman Nahid'                  // optional, gets added as a signature
  })
});
```

If you share the dashboard's remark-saving code (or the repo), I can write this integration directly into it instead of you wiring it by hand.

## Deploying on Render

[#deploying-on-render](#deploying-on-render)

- Use a **paid** web service instance (not free tier) — free tier sleeps after inactivity, which drops every WhatsApp session.
- Sessions for all accounts are stored in Turso (not on local disk), so no persistent disk is required for reconnects — but the service still needs to stay running to keep the live socket connections open.
- Set `API_KEY`, `TURSO_DB_URL`, and `TURSO_DB_TOKEN` as environment variables in Render's dashboard, not committed to the repo.

## Endpoints summary

[#endpoints-summary](#endpoints-summary)

| Method | Path                             | Purpose                                                  |
| ------ | --------------------------------- | --------------------------------------------------------- |
| GET    | `/`                                | Status page for all accounts                               |
| GET    | `/admin`                          | Manage accounts and group mappings                          |
| GET    | `/qr/:accountId`                  | Scan to connect a specific account                          |
| GET    | `/pair/:accountId`                | Pairing-code page for a specific account                    |
| GET    | `/api/status`                     | JSON connection status for every account                    |
| GET    | `/api/status/:accountId`          | JSON connection status for one account                      |
| GET    | `/api/accounts`                   | List all accounts (needs `x-api-key`)                       |
| POST   | `/api/accounts`                   | Add a new account: `{ "label": "..." }` (needs `x-api-key`) |
| DELETE | `/api/accounts/:accountId`        | Remove an account, wiping only its own session (needs `x-api-key`) |
| GET    | `/api/groups/:accountId`          | List WhatsApp groups + IDs for one account (needs `x-api-key`) |
| GET    | `/api/mapping`                    | View current dashboard→group mapping                        |
| POST   | `/api/mapping`                    | Add/update a mapping entry (now includes `account_id`)      |
| DELETE | `/api/mapping/:dashboard_name`    | Remove a mapping entry                                       |
| POST   | `/api/send-remark`                | Send a remark to its mapped group, via the mapped account    |

---

Powered by NAHID
