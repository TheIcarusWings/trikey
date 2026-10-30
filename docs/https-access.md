# Reaching the guardian over HTTPS

Written 30 October 2026. This is phase 1 of [`design/passkey-unlock.md`](design/passkey-unlock.md). Nothing here has
been run on a real Umbrel yet. Every step that rests on a report instead of a check is marked **Unconfirmed**: do
that step, look at the result, and only then carry on. If the result differs from what is written here, stop and send
it to us; do not work around it by switching Umbrel's login off.

Passkey sign-in for the guardian is not built yet. This guide gets the box ready, and it is also useful now: you get
a valid lock in the browser and a stable address for the guardian.

The guardian's web page is served by Umbrel's `app_proxy` at `http://umbrel.local:3010`, behind Umbrel's own login.
Plain HTTP on the home network is fine for the passphrase today. It cannot be used for passkeys.

## 1. Why HTTPS, and why one address

- **Passkeys need a secure page.** Browsers only offer passkeys (WebAuthn) on an `https://` page whose certificate they
  trust, or on `localhost`. A certificate warning that you click through does not count: the browser still refuses.
- **A passkey belongs to a host name.** It works at the address it was made at and nowhere else. Another host name, even
  one that reaches the same guardian, does not see it. The port is not part of the name: `https://<name>` and
  `https://<name>:8443` share one passkey.
- **So pick one address and keep using it.** Write it down. If you later change the access path, rename the machine in
  Tailscale or change the tailnet's DNS name, the passkey stops working at the new address. The passphrase keeps
  working, and you add a new passkey there. The guardian will list each passkey with the address it belongs to.

## 2. Pick a path

| | Path A: Tailscale | Path B: own domain behind a reverse proxy |
|---|---|---|
| Address | `https://<machine>.<tailnet>.ts.net` | `https://guardian.<your-domain>` |
| You need | A Tailscale account, the Tailscale app on the Umbrel, Tailscale on each device you use | A domain with DNS you can script, a proxy on the box (Caddy or Nginx Proxy Manager), a DNS certificate |
| Reachable from | Devices signed in to your tailnet | Wherever your DNS record leads: a VPN (best), or your home network |
| Setup work | Small | Larger, and more to go wrong |
| Use it when | You want the least work. This is the supported path. | You want a name of your own, or a name that does not change |

Start with path A. If it does not work on your Umbrel, or you want your own name, use path B.

Two ways to reach the web page remotely exist that are **not** passkey paths: Umbrel's Tor address (`.onion`) and an SSH
tunnel (`ssh -L 3010:localhost:3010 umbrel@umbrel.local`, then `http://localhost:3010`). They are fine for signing in with the
passphrase when you are away. Tor Browser does not support passkeys, and `localhost` is shared with every other service on
that computer. Umbrel's own local HTTPS certificate (Settings, Advanced settings, Network) is also not a passkey path: it
covers `umbrel.local` and the box's IP, needs its CA installed on every device, and Chrome reportedly refuses passkeys for
`.local` names.

## 3. Path A: Tailscale on Umbrel

### What the Tailscale app is

From its package in Umbrel's app store (`getumbrel/umbrel-apps`, `tailscale/docker-compose.yml`, read 30 October 2026):
the app is one container, `tailscale/tailscale`, with `network_mode: "host"`, `NET_ADMIN` and `/dev/net/tun`. It runs
`tailscaled` in kernel mode on the box itself and a small web page on port 8240. So:

- The **whole Umbrel is one Tailscale machine**, not one machine per app. Umbrel's remote-access page says the box is then
  reachable at `http://umbrel` (MagicDNS) or at its Tailscale IP.
- Because the container shares the box's network, `localhost` inside it is the Umbrel itself, and `localhost:3010` is the
  guardian's `app_proxy`. That is what lets `tailscale serve` point at it.
- Tailscale makes the connection private: only devices in your tailnet reach the address. It is not reachable from the
  public internet unless you turn on Tailscale Funnel, which this guide never does.
- Umbrel's app does not turn on HTTPS for you. A Tailscale certificate is made by `tailscale serve`, not by Umbrel.

You will end up with the guardian at the **root** of a host name: `https://<machine>.<tailnet>.ts.net`. Do not map it to a
path (`--set-path`): the guardian's web page is built to live at `/`. `<machine>` is the name the Umbrel has in Tailscale
(`umbrel` unless you renamed it) and `<tailnet>` is your tailnet's DNS name. Both are visible in the Tailscale admin console.

**umbrelOS 2.0 beta.** The steps below are written for umbrelOS 1.x. The 2.0 beta (September 2026) serves Umbrel itself over
HTTPS with its own local certificate and runs the app gateway inside `umbreld` instead of an `app_proxy` container. Whether
the guardian is still on `localhost:3010` there is **unconfirmed**; step 3 checks it.

### Before you start

- The Tailscale app is installed on the Umbrel and signed in. On the Umbrel home screen, open it; the Umbrel should be listed
  in the Tailscale admin console under Machines.
- Tailscale is installed and signed in on the computer or phone you will browse from.
- The guardian is **set up already** (the passphrase is chosen). Until setup is done, the guardian's setup page is open to
  anyone who can reach it, so do not publish the address before you have finished it.
- You have the Umbrel login password at hand.

### Steps

1. **Turn on MagicDNS and HTTPS certificates for your tailnet.** In the Tailscale admin console, open the DNS page. Turn on
   MagicDNS if it is off. Under HTTPS Certificates, enable HTTPS and accept the notice that machine names and the tailnet DNS
   name are listed on a public ledger.
   *You should see:* MagicDNS and HTTPS Certificates both shown as enabled. Tailscale's dev-server guide says new tailnets
   have both on by default. If the page already shows them on, go on.
   The public ledger is the Certificate Transparency log. Anyone can then look up that a machine called `<machine>` exists in
   `<tailnet>.ts.net`. If that matters, rename the machine to something neutral in the admin console **before** step 4, and
   remember that renaming it later changes your passkey address.

2. **Open a shell in the Tailscale app.** On the Umbrel: Settings, Advanced settings, Terminal, then select Tailscale as the
   app. That path is from an older Umbrel forum thread and is **unconfirmed** on your version. If you cannot find it, use SSH
   and run `sudo docker ps`, find the container whose name starts with `tailscale_`, and use
   `sudo docker exec -it <that-name> sh`. (An older thread names it `tailscale_web_1`.)
   *You should see:* a shell prompt. `tailscale status` lists this Umbrel and your other devices.

3. **Check what already uses `serve`, and check the guardian's port.**
   ```sh
   tailscale serve status
   curl -sI http://localhost:3010
   ```
   *You should see:* `serve status` lists nothing, or lists what you set up before (keep that in mind: step 4 adds to it, and
   `tailscale serve reset` would delete all of it). `curl` prints an HTTP status line: probably a redirect to Umbrel's login,
   or 200. It is the guardian's `app_proxy` answering. If `curl` is missing in this shell, try
   `wget -S --spider http://localhost:3010`; if the connection is refused, the guardian is not running on that port. Open the
   app from the home screen first, and see "If something goes wrong".

4. **Serve the guardian over HTTPS.**
   ```sh
   tailscale serve --bg --https=443 http://localhost:3010
   ```
   The target is `http://` because `app_proxy` speaks plain HTTP; `serve` is the part that adds the certificate.
   *You should see:* the command prints the address it is serving, `https://<machine>.<tailnet>.ts.net`, and says it proxies
   to `http://127.0.0.1:3010` (Tailscale's own wording may differ). If HTTPS certificates were off, the command instead prints
   a link or asks you to approve turning them on: do step 1, then run it again. Then:
   ```sh
   tailscale serve status
   ```
   *You should see:* the same address, listed with `/` going to `http://127.0.0.1:3010`.
   `--bg` keeps the setting after the command ends and after a reboot of the device (Tailscale's Serve documentation). That it
   also survives an Umbrel restart or an update of the Tailscale app is **unconfirmed**: the app keeps its state in its own data
   folder, so it should. Check `tailscale serve status` after the first restart.

5. **Open the address from another device.** On a computer or phone that is signed in to the tailnet, open
   `https://<machine>.<tailnet>.ts.net`. The first request takes a few seconds: Tailscale gets the certificate then.
   *You should see:* a lock in the address bar, then either the guardian's sign-in page, or Umbrel's login first.
   **Unconfirmed:** whether Umbrel's login still applies on this address and how it behaves. What is known:
   - `app_proxy` asks for Umbrel's login whenever it has no Umbrel session for the request. That session is a cookie, and a
     cookie belongs to a host name, so the one you got at `umbrel.local` is not sent to `<machine>.<tailnet>.ts.net`. Expect
     Umbrel's login on first use here, and log in with the Umbrel password.
   - Reports for umbrelOS 1.6 and the 2.0 beta say that the login redirects to **port 2000** on the same host name
     ([umbrel #2215](https://github.com/getumbrel/umbrel/issues/2215), [#2242](https://github.com/getumbrel/umbrel/issues/2242)).
     On 2.0 beta 2 that port presents Umbrel's own certificate, so a name it does not know shows a certificate warning, or the
     page does not load at all. `serve` as set up above only answers on port 443, so a redirect to `:2000` has nowhere to go.
   - If you reach the guardian's page with a valid lock after logging in: go on to step 6.
   - If you are sent to a `:2000` address that does not load: this is the known problem above. **Do not switch Umbrel's login
     off to get around it.** Leave things as they are, make a note of the address you were sent to (without the `app` and
     `path` values, if any), and tell us. Path B hits the same step, so it does not get you around it either. The guardian
     asks for its own passphrase before it shows anything but the sign-in page, which is one lock behind Umbrel's; Umbrel's
     login is the second. Turning the second one off for an address that only your tailnet can reach is an owner's decision
     we will describe once we have seen how it behaves, not a step in this guide.

6. **Check the certificate** (section 5), and write the address down.

To undo path A: `tailscale serve --bg --https=443 http://localhost:3010 off` (the same command with `off` at the end), or
`tailscale serve reset` to remove every serve setting. The Umbrel dashboard and every other app keep working at
`http://umbrel.local` and `http://umbrel` throughout. Path A does not change them.

## 4. Path B: your own domain behind a reverse proxy

More work than path A, and the guardian must stay behind Umbrel's login and out of the public internet. Read "What not to do"
first.

You need a domain whose DNS you control and can change through an API (most registrars and DNS hosts offer one), and a
**dedicated** host name for the guardian, such as `guardian.<your-domain>`. Dedicated matters: a passkey belongs to the host
name, and every app shared on one name shares its passkeys.

1. **Choose where the name points.** From safest to least safe:
   - **The Umbrel's Tailscale IP** (a `100.x.y.z` address, shown in the Tailscale app). An ordinary `A` record on your public
     DNS, with a private target. Only devices in your tailnet can connect. This is the "VPN-only domain", and the one to
     choose. Nothing about the box is reachable from the internet.
   - **The Umbrel's address on your home network** (for example `192.168.x.y`), either as a public `A` record or as a local
     DNS entry on your router or a Pi-hole (split DNS). Works at home only. Some routers drop a public answer that points at
     a private address ("DNS rebinding protection"); a local DNS entry avoids that.
   - **Never your public IP** with a port forward. See "What not to do".
   *You should see:* `nslookup guardian.<your-domain>` on a device that is meant to reach it prints the address you chose, and
   a device that is not meant to reach it (a phone on mobile data, outside the tailnet) cannot connect to that address.

2. **Run a reverse proxy on the Umbrel.** Nginx Proxy Manager (an app in some Umbrel stores, or a container you run yourself)
   or Caddy. The proxy listens for HTTPS and forwards to the guardian's `app_proxy`.
   - Forward to `http://<umbrel-lan-ip>:3010` (plain HTTP, the guardian's port on the box). The LAN IP of the box is the one
     the proxy container can reach; `localhost` inside a container is the container itself.
   - Pass the original `Host` and the `X-Forwarded-Proto: https` and `X-Forwarded-Host` headers. The guardian reads
     them: it marks the session cookie `Secure` only when it sees `X-Forwarded-Proto: https`, and its cross-site check compares
     the browser's `Origin` with `Host` or `X-Forwarded-Host`. Caddy sets the `X-Forwarded-*` headers by default. For Nginx
     Proxy Manager this is **unconfirmed**: check after setup (below).
   - The port the proxy itself listens on varies by Umbrel app. If another Umbrel service already uses 443, use a different
     port for the proxy and put it in the address (`https://guardian.<your-domain>:<port>`). The port is not part of the passkey.

3. **Get a certificate with the DNS challenge.** Let's Encrypt can check that you own the name by a TXT record in your DNS,
   so the box needs no open port and no public address.
   - **Caddy:** add your DNS provider's module (Caddy does not include them; build one with `xcaddy build --with <module>`
     or use the download page) and put `tls { dns <provider> <token> }` in the site block. Keep the token in an environment
     variable. See Caddy's "Automatic HTTPS" and `tls` pages.
   - **Nginx Proxy Manager:** it uses Certbot DNS plugins. When you ask for a certificate, choose the DNS challenge and your
     provider, and paste the provider's API credentials. The labels differ between versions, so read the screen. The plugin
     support is uneven by provider (the project's Certbot page says so): if the request fails, the proxy's container log shows
     the Certbot error.
   - Use a token that can edit only this domain's DNS records, not your whole account.
   *You should see:* a certificate for `guardian.<your-domain>`, issued by Let's Encrypt, with an expiry about 90 days ahead
   and a note that it renews by itself.
   The name goes into Certificate Transparency logs the moment the certificate is issued, whatever the DNS record points at.
   Use a name that tells a stranger nothing about what is behind it.

4. **Add the proxy host for the guardian**: `guardian.<your-domain>` to `http://<umbrel-lan-ip>:3010`, with the certificate from
   step 3 and HTTP to HTTPS redirect on. WebSocket support: not needed as far as we know; turn it on if your proxy has the
   switch and the page misbehaves.

5. **Open `https://guardian.<your-domain>`** from a device that is meant to reach it, with a valid lock, and go through
   Umbrel's login as in path A step 5. The same **unconfirmed** question applies: Umbrel's login may send you to its port 2000
   and its own certificate, which does not cover your name ([umbrel #2242](https://github.com/getumbrel/umbrel/issues/2242)).
   A community guide for umbrelOS 2.0 that puts Nginx Proxy Manager behind Tailscale Serve advises switching Umbrel's app
   authentication off for the apps it fronts. We do not recommend that for the guardian. If you are stopped here, stop, and tell us.

6. **Check the certificate** (section 5), and write the address down.

## What not to do

- **Do not forward a port from your router to the guardian, and do not point public DNS at your public IP.** The guardian
  has two locks, Umbrel's login and its own passphrase. A public address invites password guessing, scanners and every
  future bug in either layer, against the key that co-signs your bitcoin payments. Umbrel's login must stay in front of the
  guardian on any address, and a VPN-only address (path A, or path B with a Tailscale IP) adds a third barrier.
- **Do not turn off Umbrel's login for the guardian, or put it on a public address without it.** If Umbrel's login does not
  work on your address, that is a reason to stop, not a setting to flip. (The 2.0 beta has an app setting for it, reported in
  [umbrel #2242](https://github.com/getumbrel/umbrel/issues/2242). Leave it on.)
- **Do not use Tailscale Funnel** for the guardian: it publishes the address to the internet.
- **Do not use a self-signed certificate, or click through a warning.** Browsers refuse passkeys on such a page, and the
  habit of clicking through is what makes real attacks work. Umbrel's local certificate is the same thing for this purpose,
  unless you install its CA on every device, and even then Chrome reportedly refuses `.local` names.
- **Do not reuse the address of another app** or the Umbrel dashboard for the guardian. Give it its own host name.
- **Do not run the setup page on an address other people can reach** before you have finished setting up and chosen the
  passphrase.

## 5. How to verify

Do this on a device other than the Umbrel, from the address you chose.

1. Open the guardian at the HTTPS address. The browser shows a closed lock, with no warning page and no "not secure" label.
2. Click the lock and open the certificate. It names your host name (`<machine>.<tailnet>.ts.net` or
   `guardian.<your-domain>`), is issued by Let's Encrypt, and has dates that include today.
3. From a terminal, the same check in one line:
   ```sh
   curl -svI https://<your-address> 2>&1 | grep -iE 'subject:|issuer:|expire|verify|HTTP/'
   ```
   *You should see:* your name as subject, Let's Encrypt as the issuer, `SSL certificate verify ok`, and an HTTP status.
   (If curl is run on the Umbrel itself it may not resolve the name; run it from your computer.)
4. In the browser's developer console on the guardian page, type `window.isSecureContext`. *You should see:* `true`.
   That is the condition passkeys need.
5. Sign in with the passphrase at this address and look at the guardian's Home. A `403 Rejected: Origin does not match this
   host` from the guardian means the proxy changed `Host` and did not pass `X-Forwarded-Host`; see the troubleshooting list.
6. **Write the address down.** It is the address your passkey will belong to.

**`trikey.app/passkey-test` is a different site.** It tests whether your password manager can make a passkey and return PRF
output. Its passkey belongs to `trikey.app` and is useless here, and a passing test there says nothing about this address. The
real passkey for the guardian will be made on the guardian's own HTTPS address, once passkey sign-in ships (phase 2 of the
design). Until then, the passphrase is the only way in, and this guide's result is a valid lock and a stable address.

## 6. If something goes wrong

- **A certificate warning on `*.ts.net`.** `serve` is not running (`tailscale serve status` lists nothing), HTTPS
  certificates are off in the admin console (step 1), or you opened `http://umbrel` or the Tailscale IP. Only the full
  `https://<machine>.<tailnet>.ts.net` name has a certificate.
- **The page does not load, or times out.** The device you browse from is not signed in to the tailnet (open its Tailscale
  app and check it is connected), MagicDNS is off, or `serve` is not running. On the Umbrel, `tailscale serve status` must list
  the address.
- **A 502 or "Bad Gateway".** `serve` works and the guardian does not answer on `localhost:3010`. Open the guardian from the
  Umbrel home screen: if that fails too, see the alpha test plan's install troubleshooting and its logs.
- **A redirect to `:2000`, or to `umbrel.local`, that does not load.** The known Umbrel login problem (path A, step 5). Stop
  there and report it, with the address you were sent to.
- **The guardian says `Rejected: Origin does not match this host` after sign-in.** The cross-site check failed. Browsers send
  `Sec-Fetch-Site: same-origin` on HTTPS pages, which passes it, so this means something in the chain removed that header and
  changed `Host`. Send the log line (`sudo umbreld client apps.logs.query --appId trikey-guardian`).
- **The session cookie has no `Secure` flag** (browser developer tools, the cookie list for the address, cookie
  `trikey_session`). The guardian sets `Secure` only if it sees `X-Forwarded-Proto: https`. Whether `tailscale serve` adds that
  header is **unconfirmed**. It does not break sign-in; tell us, it matters for the passkey phase.
- **Path B: valid lock, wrong name in the certificate.** The proxy host has no certificate of its own and the proxy used its
  default one. Assign the certificate to the host.
- **Path B: the name does not resolve on a device at home.** Your router blocks public answers with private addresses; add a
  local DNS entry for the name, or use the Tailscale IP.
- **Works on the computer, not on the phone.** The phone is not connected to Tailscale (path A, and path B with a Tailscale IP),
  or it uses a private DNS setting that bypasses MagicDNS.
- **The certificate expired.** `serve` and Caddy renew by themselves; a renewal that failed is in the log. On Nginx Proxy
  Manager, the renewal also needs the DNS token to still be valid.
- **After you renamed the machine, changed the tailnet name or the domain.** The address changed, so the passkey for the old
  one will not show up. The passphrase still works.

## What this guide could not confirm

These are the places where we wrote what the documentation or a report says, not what we saw. Each is marked in the text.

1. How to open a shell in the current Tailscale app on umbrelOS (the Terminal path and the container name).
2. That the guardian's `app_proxy` answers on `localhost:3010` from inside the Tailscale container, on 1.x and on the 2.0 beta.
3. The exact text `tailscale serve` prints, and that its setting survives an Umbrel restart and an update of the app.
4. How Umbrel's login behaves when the guardian is reached at a `ts.net` name or your own name (redirect to port 2000,
   Umbrel's own certificate), and whether `app_proxy` checks the `Host` header at all. We found no documentation for either;
   the only evidence is the issue reports linked above.
5. Whether `tailscale serve` forwards the original `Host` to a plain HTTP target, and whether it sets `X-Forwarded-Proto` (one
   report says it keeps the original `Host` for TCP backends; another says Unix-socket backends get `Host: localhost`).
6. Whether Nginx Proxy Manager passes `X-Forwarded-Host` and `X-Forwarded-Proto` by default.
7. That a public DNS record pointing at a Tailscale IP works for your registrar and your devices (it is plain DNS, and the
   community guide below uses the same idea, but we have not tried it).

## Sources

Checked on 30 October 2026. "Read" means the page was opened and read. "Summary" means only a search summary of the page was
available when this was written (the site was not reachable from where it was written); read those pages before relying on them.

- Read: Tailscale app package for Umbrel, [docker-compose.yml](https://github.com/getumbrel/umbrel-apps/blob/master/tailscale/docker-compose.yml)
  and `umbrel-app.yml` (host networking, `tailscale web` on 8240, version 1.104.4).
- Read: [getumbrel/umbrel-apps #758](https://github.com/getumbrel/umbrel-apps/issues/758) (Tailscale HTTPS request; `tailscale cert` alone
  does not make the apps use the certificate; apps are HTTP only).
- Read: [getumbrel/umbrel #1317](https://github.com/getumbrel/umbrel/issues/1317) (`tailscale cert` runs inside the Tailscale container).
- Read: [getumbrel/umbrel #2215](https://github.com/getumbrel/umbrel/issues/2215) (Umbrel 1.6: app URL redirects to the dashboard on
  port 2000 for login; Fetch Metadata headers pass through the proxy).
- Read: [getumbrel/umbrel #2242](https://github.com/getumbrel/umbrel/issues/2242) (2.0 beta 2: the auth redirect goes to the same host
  name on port 2000, which presents Umbrel's own certificate; open, no maintainer reply seen) and
  [#2240](https://github.com/getumbrel/umbrel/issues/2240) (2.0 gateway runs inside `umbreld`).
- Read: [umbrelOS 2.0 Beta 1 release notes](https://github.com/getumbrel/umbrel/releases/tag/2.0.0-beta.1) ("served over HTTPS automatically").
- Read: [Vaultwarden discussion #6378](https://github.com/dani-garcia/vaultwarden/discussions/6378), 21 October 2025:
  `tailscale serve --https / http://localhost:8089` from Umbrel's Tailscale terminal gives `https://<hostname>.<tailnet>.ts.net`.
- Summary: Umbrel support, [Remote access](https://umbrel.com/support/basics/remote-access) and
  [Accessing your Umbrel over HTTPS](https://umbrel.com/support/basics/accessing-your-umbrel-over-https) (Tailscale is the
  recommended remote access; the local certificate does not cover Tailscale addresses).
- Summary: Umbrel community guide, [Make Umbrel Apps Available via Custom Domains with a Valid SSL Certificate Inside Your Tailnet on
  Umbrel OS 2.0](https://community.umbrel.com/t/make-umbrel-apps-available-via-custom-domains-with-a-valid-ssl-certificate-inside-your-tailnet-on-umbrel-os-2-0/25621)
  (DNS to the Tailscale IP, `tailscale serve --tcp=443` to Nginx Proxy Manager; posted October 2026).
- Summary: [DeepWiki on Umbrel's app proxy](https://deepwiki.com/getumbrel/umbrel/2.4-app-proxy-and-auth-containers) (third party:
  the proxy checks a session cookie and sends unauthenticated requests to the app-auth service on port 2000).
- Summary: Umbrel community, [How to use Tailscale with Umbrel](https://community.umbrel.com/t/how-to-use-tailscale-with-umbrel/6782)
  (Settings, Advanced settings, Terminal, select Tailscale as the app).
- Summary: Tailscale, [Enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates) (admin console DNS page, MagicDNS,
  HTTPS Certificates, public ledger), [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) and
  [`tailscale serve` command](https://tailscale.com/docs/reference/tailscale-cli/serve) (`--bg`, `--https`, `off`, `reset`),
  [Funnel](https://tailscale.com/docs/features/tailscale-funnel).
- Summary: Caddy, [Automatic HTTPS](https://caddyserver.com/docs/automatic-https) and
  [`tls`](https://caddyserver.com/docs/caddyfile/directives/tls) (DNS challenge needs a provider module and no open port).
- Summary: Nginx Proxy Manager, [Certbot DNS plugins](https://nginxproxymanager.com/certbot/).
- Summary: Let's Encrypt community, certificate names appear in public Certificate Transparency logs.
- The passkey constraints (secure context, host name as relying-party ID) are in [`design/passkey-unlock.md`](design/passkey-unlock.md), section 1.
