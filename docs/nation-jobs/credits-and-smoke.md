# Credits and VPS review — Base USDC launch candidate

This branch starts at the preserved billing commit and replaces its expiring
allowance design. It also carries the reviewed branding and connector changes.
No merge, deployment, production purchase, or live VPS modification was made.
The combined candidate at `d8fab572acd9fa21795b7490387c906410ca4abc` passes the strict public asset and captured member API guard. Browser and production smoke gates remain pending; this is not a deployment record.

## Accounting and payment behavior

The authoritative balance is SUM(amount_micros) in `nation-credits.db`, in the
existing resolved data directory. Integer microdollars avoid floating-point
ledger drift. Each free grant, purchase, usage charge or manual adjustment is
one immutable balance row. There is no expiry job, recurring charge, allowance,
approval transaction, or billing contract.

Managed chat requests, every tool round, text helpers and avatar images request
usage accounting and charge actual `usage.cost` multiplied by the configured
markup. `server/spend.ts` owns the admission/settlement path; both the displayed
balance and zero-credit gate use this ledger. Regular managed turns are routed
to NATION API, including self-hosted computer turns. In-flight requests may
finish over the remaining balance; subsequent requests stop. Owner/admin
exemption requires an authenticated admin scope AND a product owner/admin flag.
Exempt calls still record actual provider cost for the daily report.

Missing costs are never estimated as zero. A pending receipt blocks further
spending. The server reconciles provider generation IDs every 30 seconds. After
a crash, unresolved active calls block admission too; automatic reconciliation
waits ten minutes before inspecting abandoned active calls. Across processes,
an unresolved call owned by another worker conservatively blocks concurrent
admission for that account. Admin can resolve a missing receipt only by entering
the confirmed actual cost and an audit reason. Confirm no billing before using
zero. Normal settled usage is never edited by that operation.

An email must come from the existing verified sign-in session. A paired device
alone is not a verified account. Wallet verification uses a five-minute,
single-use, session-bound signed nonce; it authorizes no payment. Starter grants
are unique by account, limited by IP per UTC day, and unique per device cookie.
IP and device values are hashed in storage. Known disposable email domains and
operator additions are blocked. The bundled disposable-domain list is finite;
maintain the additional list as abuse patterns change. Clearing cookies can
change a browser device identifier; this is not hardware attestation.

Invoices store chain, token, treasury, unique exact microtoken amount and the
creation block. The small matching suffix is added to the selected pack and is
fully credited. Amounts are never reused, even after the 30-minute invoice
window. Late matching transfers remain claimable and are scanned automatically
with persisted block cursors. Payment RPC verifies chain, successful canonical
receipt, token Transfer event, destination, amount and confirmation depth.
Transaction hashes have a unique index. The browser cannot mint credit.

The approved launch enables **Base USDC only**: chain 8453, six-decimal token
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, receiving treasury
`0x85E3C2D8f776d9D05b14E108F368070CbD8C1639` (supplied by the founder on 2026-09-24).
The address checksum and Base-only configuration have been checked. This does
not prove wallet ownership or a completed transfer. Robinhood remains disabled.
The payment screen offers exact address/amount, an ERC-681 QR, injected-wallet
ERC-20 transfer, and transaction-hash fallback. Wallet network gas is separate.

## Environment and founder decisions

| Setting | Default |
| --- | --- |
| NATION_FREE_CREDIT_USD | 3, allowed 2–5 |
| NATION_CREDIT_MARKUP | 1.0 |
| NATION_LOW_BALANCE_USD | 0.50 |
| NATION_PACKS_USD | 10,25,100 |
| NATION_FREE_GRANTS_PER_IP_PER_DAY | 2 |
| NATION_CONFIRMATIONS | 3 |
| NATION_TREASURY_BASE / NATION_TREASURY_ROBINHOOD | unset; top-up hidden |
| NATION_RPC_BASE | https://mainnet.base.org |
| NATION_RPC_ROBINHOOD | https://rpc.mainnet.chain.robinhood.com |
| NATION_IMAGE_MODEL | openai/gpt-image-2, server-only |
| NATION_TRUST_PROXY | 0 |
| NATION_DISPOSABLE_EMAIL_DOMAINS | empty, extends bundled block list |
| NATION_PRODUCT_OWNER / NATION_PRODUCT_ADMIN | 0; existing authenticated admin scope also required |
| NATION_DATA_DIR | new directory if present, otherwise existing legacy data in place |

The founder selected Base USDC only and supplied the treasury above. The reviewed
non-secret overlay is `deploy/nation-base-usdc.env`. Apply only its two values to
the API process configuration during the approved release; it is not a complete
.env file and must not replace existing credentials, owner flags or data paths.
Explicitly clear the Robinhood treasury, including any inherited process value.
The overlay has not been applied to production. Existing defaults remain as shown
above. RPC capacity, additional disposable domains and proxy configuration remain
operator settings.
The unique amount suffix can be up to $0.999999 and is fully credited; review
that UX before launch. Default markup 1.0 does not cover other operating costs.
Public RPCs may throttle historical receipt scans; retained invoices and pasted
transaction hashes remain available.

## Local validation

Run `pnpm typecheck`, then the focused tests:

```sh
pnpm exec vitest run server/nation-credits.test.ts server/nation-credits.e2e.test.ts server/drivers/openai-chat-tools.test.ts server/spend.test.ts server/avatar-image.test.ts server/request-auth.test.ts
pnpm exec vitest run server/connector-policy.test.ts server/workspace-backup.test.ts server/message-db.test.ts
pnpm exec vite build
pnpm brand-guard
```

The isolated HTTP fixture uses a temporary data directory, a freshly generated
test-wallet signature and a loopback mock provider. It proves $3 free credit,
$0.60 chat debit, $0.10 image debit, the remaining $2.30 chat debit, then HTTP 402
with no further model request. It records actual-cost ledger evidence. RPC tests
cover wrong chain/token/destination/amount, reused hashes, reorgs, failed
receipts and insufficient confirmations. No live keys or paid services are used.
Final independent run on `d8fab572`: frozen dependency install and `pnpm build`
(including both TypeScript checks, Vite and the strict guard) passed. The guard
reported 88 built assets / zero matches, and 89 files / zero matches when adding
the captured member API responses. Eighteen tests across the credit ledger,
real HTTP credit flow and real HTTP import/routine/webhook flow passed in 7.77s.
Earlier focused protocol, workspace restore, privacy and UI checks are recorded
in `branding-audit.md`. No full test suite, real payment or paid model call was
run. Browser verification and founder production smoke remain outstanding.

## Founder-run VPS smoke

Before deployment, preserve the current data inventory:

```sh
cd /opt/nation-team-chat
scripts/smoke-live.sh --record-data
```

After founder deployment, supply a **fresh verified regular test account** token
and a separate owner/admin token through the shell environment, then run:

```sh
scripts/smoke-live.sh --exercise
```

Required settings: `NATION_SMOKE_MEMBER_TOKEN`, `NATION_SMOKE_ADMIN_TOKEN`.
Optional locations: `NATION_SMOKE_SITE` (live /swarm/ URL), `NATION_SMOKE_API`
(http://127.0.0.1:8799), `NATION_SMOKE_OUTPUT` (/tmp/nation-smoke),
`NATION_SMOKE_BASELINE` (saved data-before.json).
For the desktop check supply `NATION_SMOKE_DESK_CONTAINER` for the created bot
and `NATION_SMOKE_WALLPAPER_SHA256` for the approved iOS 27 silver-ribbon asset.
The script saves a desk screenshot, checks the active wallpaper hash and Chrome
process, and requires a working VPS viewer. Review the screenshot too. The
requested wallpaper is not present as a verifiable asset in this checkout;
its live appearance has not been certified or replaced by this work.

The exercise creates a clearly named test bot, spends real test-account credit,
temporarily removes the remainder to test zero, and restores that adjustment
in a finally block. It prints the bot ID for founder cleanup. It never deletes
bots, messages, data directories or production settings. Missing prerequisites
print FAIL, not PASS. Read-only mode also reports unexecuted exercise checks as
FAIL. HTTP failures, unavailable PM2, or a mismatched wallpaper exit nonzero.

The script checks retained bot IDs and message IDs against the before inventory,
plus SQLite quick_check and WAL mode. New credit data has owner-only file
permissions, busy timeout and synchronous FULL. The message DB now sets a
five-second busy timeout before enabling WAL. No specific live WAL warning was
available to reproduce; this change is not a claim that an unseen warning is
fixed. Never delete a WAL file to silence a warning.

## Financial backup and restore

Workspace backups exclude the financial DB and its WAL/SHM and preserve the
current ledger during restore. Rolling back a workspace must not roll back
payment replay protection or credit balances. Back up the financial DB
separately with SQLite's online backup API into an owner-only, encrypted backup
destination. Do not copy only the main file while the API is running. For a
disaster recovery restore, stop spending first and reconcile transfers and usage
since the backup before reopening the service. This PR does not configure an
off-site backup service or migrate data.

## Duplicate nginx server name — inspect, do not apply

The live warning mentions duplicate `hermes.thenation.city` server names. The
actual enabled nginx files were not accessible here, so no filename is invented.
On the VPS, `sudo nginx -T 2>&1` shows each `# configuration file ...` boundary.
Find all `server_name` declarations containing that hostname and compare their
`listen` address/port pairs. Keep the hostname in exactly one server block for
each listen pair (one port-80 and one port-443 block are normal).

The exact directive correction in each **duplicate** block is:

```diff
- server_name hermes.thenation.city other.example;
+ server_name other.example;
```

If the duplicate block serves only that hostname, disable that duplicate enabled
site instead of leaving an empty server_name. Preserve the canonical block's
TLS certificate, locations and upstream. Then the founder runs `sudo nginx -t`
and, only after reviewing the chosen file, reloads nginx. No config edit, reload,
DNS change, or deployment was executed by this work.

Provider reference: https://openrouter.ai/docs/cookbook/administration/usage-accounting
and https://openrouter.ai/docs/guides/overview/multimodal/image-generation.
