/**
 * A Bitcoin checkout screen, standing in for the storefront that a merchant
 * would build. It follows the flow of the Blockonomics WooCommerce plugin:
 *
 *   - QR code, "Open in wallet", address and amount with copy-to-clipboard
 *   - price lock countdown; on expiry (or the refresh icon) the amount is
 *     re-quoted through the plugin's store route, keeping the address
 *   - the Blockonomics WebSocket drives the page: the first message switches
 *     to the receipt screen, later ones advance the confirmation count
 *   - an underpayment shows what was paid and what is left, in fiat; once it
 *     confirms, the remainder is quoted on a fresh address at the current
 *     rate and "Pay remaining" returns to the payment screen for it
 *
 * Fulfilment stays with the callbacks: the order is placed server-side once
 * the configured confirmations arrive, and the receipt screen picks it up.
 *
 *   node scripts/checkout-demo.js [cart_id]
 *
 * Then open http://localhost:8000 (which STORE_CORS already allows).
 */

const http = require("http")

const PORT = Number(process.env.DEMO_PORT ?? 8000)
const MEDUSA = process.env.MEDUSA_URL ?? "http://localhost:9000"
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@medusa.local"
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "supersecret"
const CART_ID = process.argv[2] ?? process.env.CART_ID ?? ""
const WS_URL = process.env.BLOCKONOMICS_WS_URL ?? "wss://www.blockonomics.co"

async function getPublishableKey() {
  const auth = await fetch(`${MEDUSA}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }).then((r) => r.json())

  const keys = await fetch(`${MEDUSA}/admin/api-keys?type=publishable&limit=1`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  }).then((r) => r.json())

  return keys.api_keys[0].token
}

const page = (publishableKey) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pay with Bitcoin</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
  :root {
    color-scheme: light dark;
    --bg: oklch(97% 0.004 80);
    --card: oklch(100% 0 0);
    --ink: oklch(22% 0.01 80);
    --muted: oklch(52% 0.015 80);
    --line: oklch(90% 0.006 80);
    --field: oklch(98% 0.003 80);
    --accent: oklch(72% 0.17 62);
    --ok: oklch(58% 0.16 150);
    --warn: oklch(62% 0.15 45);
    --err: oklch(55% 0.19 25);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: oklch(15% 0.008 80); --card: oklch(20% 0.008 80); --ink: oklch(96% 0.005 80);
      --muted: oklch(68% 0.012 80); --line: oklch(30% 0.008 80); --field: oklch(17% 0.008 80);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: clamp(16px, 4vw, 40px) 16px; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; justify-content: center;
  }
  .card {
    width: 100%; max-width: 480px; background: var(--card);
    border: 1px solid var(--line); border-radius: 16px; overflow: hidden;
  }
  .header {
    display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
    padding: 16px 24px; border-bottom: 1px solid var(--line); font-size: 14px;
  }
  .header .id { color: var(--muted); }
  .header .total { font-weight: 600; }
  .header-row {
    display: flex; justify-content: space-between; padding: 6px 24px; font-size: 13.5px;
    border-bottom: 1px solid var(--line);
  }
  .header-row span:first-child { color: var(--muted); }
  .body { padding: 24px; }
  .section-title {
    font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--muted); margin: 0 0 10px;
  }
  .qr-block { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-bottom: 24px; }
  #qr { padding: 12px; background: #fff; border-radius: 12px; border: 1px solid var(--line); line-height: 0; }
  #qr img, #qr canvas { display: block; }
  .wallet-link { font-size: 13.5px; color: var(--accent); text-decoration: none; font-weight: 500; }
  .wallet-link:hover { text-decoration: underline; }
  label.field-label { display: block; font-size: 13.5px; margin: 14px 0 6px; }
  .copy {
    position: relative; display: flex; align-items: center; gap: 8px;
    border: 1px solid var(--line); border-radius: 10px; background: var(--field); overflow: hidden;
  }
  .copy input {
    flex: 1; min-width: 0; border: 0; background: transparent; color: var(--ink);
    font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 11px 0 11px 12px; outline: none;
    text-overflow: ellipsis;
  }
  .copy button {
    flex: none; border: 0; background: transparent; color: var(--muted); cursor: pointer;
    padding: 10px 12px; display: inline-flex; line-height: 0;
  }
  .copy button:hover { color: var(--ink); }
  .copy .copied {
    position: absolute; inset: 0; display: none; align-items: center; justify-content: center; gap: 6px;
    background: var(--field); color: var(--ok); font-size: 13.5px; font-weight: 500;
  }
  .copy.is-copied .copied { display: flex; }
  .footer {
    display: flex; justify-content: space-between; align-items: center; gap: 12px;
    padding: 12px 24px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--muted);
  }
  #refresh {
    border: 0; background: transparent; color: var(--muted); cursor: pointer; padding: 4px; line-height: 0;
  }
  #refresh:hover { color: var(--ink); }
  #refresh.spin svg { animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .receipt { padding: 32px 24px; text-align: center; }
  .receipt .mark { width: 48px; height: 48px; margin: 0 auto 12px; color: var(--ok); }
  .receipt h2 { margin: 0 0 6px; font-size: 19px; letter-spacing: -0.01em; }
  .receipt p { margin: 0 0 8px; color: var(--muted); font-size: 14px; }
  .receipt .warn { color: var(--warn); }
  .txid {
    display: flex; align-items: center; justify-content: center; gap: 8px; margin: 14px auto;
    max-width: 100%; font-size: 12.5px; color: var(--muted);
  }
  .txid code {
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px;
  }
  .txid button { border: 0; background: transparent; color: var(--muted); cursor: pointer; padding: 2px; line-height: 0; }
  .confs { display: flex; gap: 6px; justify-content: center; margin: 18px 0 8px; }
  .confs i { width: 44px; height: 4px; border-radius: 999px; background: var(--line); }
  .confs i.on { background: var(--accent); }
  .confs i.done { background: var(--ok); }
  .btn {
    display: inline-block; margin-top: 14px; padding: 10px 18px; border-radius: 10px; border: 0;
    background: var(--accent); color: oklch(15% 0.02 62); font-weight: 600; font-size: 14px; cursor: pointer;
  }
  .order { margin-top: 14px; font-weight: 600; color: var(--ok); }
  .err { color: var(--err); font-size: 13px; padding: 16px 24px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
  <div class="card">
    <!-- Payment screen -->
    <div id="payment">
      <div class="header">
        <span class="id" id="cart-label">Cart</span>
        <span class="total" id="cart-total">-</span>
      </div>
      <div id="paid-rows" class="hidden">
        <div class="header-row"><span>Paid amount</span><span id="paid-btc">-</span></div>
        <div class="header-row"><span>Remaining amount</span><span id="remaining-btc">-</span></div>
      </div>
      <div class="body">
        <div class="qr-block">
          <p class="section-title">Scan</p>
          <a id="qr-link" href="#" target="_blank" rel="noopener"><div id="qr"></div></a>
          <a id="wallet-link" class="wallet-link" href="#" target="_blank" rel="noopener">Open in wallet</a>
        </div>

        <p class="section-title">Copy</p>
        <label class="field-label" for="address">Send Bitcoin to this address:</label>
        <div class="copy" id="copy-address">
          <input id="address" type="text" readonly value="" />
          <button type="button" aria-label="Copy address" data-copy="address">${COPY_ICON}</button>
          <span class="copied">Copied ${CHECK_ICON}</span>
        </div>

        <label class="field-label" for="amount">Amount of BTC to send:</label>
        <div class="copy" id="copy-amount">
          <input id="amount" type="text" readonly value="" />
          <button type="button" aria-label="Copy amount" data-copy="amount">${COPY_ICON}</button>
          <span class="copied">Copied ${CHECK_ICON}</span>
        </div>
      </div>
      <div class="footer">
        <span>1 BTC = <span id="rate">-</span> <span id="currency"></span>, updates in <span id="time-left">--:--</span> min</span>
        <button id="refresh" type="button" aria-label="Refresh price">${REFRESH_ICON}</button>
      </div>
    </div>

    <!-- Receipt screen -->
    <div id="receipt" class="receipt hidden">
      <div class="mark">${MARK_ICON}</div>
      <h2>Payment received</h2>
      <div class="txid">
        <span>txid</span>
        <code id="txid" title=""></code>
        <button type="button" aria-label="Copy transaction id" data-copy="txid">${COPY_ICON}</button>
      </div>
      <div id="settled">
        <div class="confs"><i id="c0"></i><i id="c1"></i><i id="c2"></i></div>
        <p id="conf-text">Waiting for network confirmation</p>
        <p>Your order will be placed automatically once the payment is confirmed. You can leave this page open.</p>
        <p class="order" id="order"></p>
      </div>
      <div id="underpaid" class="hidden">
        <p class="warn">Order was underpaid by <strong id="due"></strong>.</p>
        <p id="underpaid-conf"></p>
        <p id="underpaid-wait">The remaining amount can be paid once this payment has confirmed. You can leave this page open.</p>
        <button class="btn hidden" id="pay-remaining" type="button">Pay remaining</button>
      </div>
    </div>

    <div id="error" class="err hidden"></div>
  </div>

<script>
  const CART_ID = ${JSON.stringify(CART_ID)}
  const MEDUSA = ${JSON.stringify(MEDUSA)}
  const KEY = ${JSON.stringify(publishableKey)}
  const WS_URL = ${JSON.stringify(WS_URL)}
  const SATS = 100000000
  const FINAL_CONFIRMATIONS = 2

  const $ = (id) => document.getElementById(id)
  const btc = (sats) => (sats / SATS).toFixed(8)

  let session = null
  let cart = null
  let qr = null
  let timer = null
  let ws = null
  let wsAttempt = 0
  let wsClosed = false
  let orderPoll = null

  // ---- Data -------------------------------------------------------------

  const fetchCart = async () => {
    const res = await fetch(MEDUSA + "/store/carts/" + CART_ID, {
      headers: { "x-publishable-api-key": KEY },
    })
    if (!res.ok) throw new Error("Cart request failed with " + res.status)
    cart = (await res.json()).cart
    return cart
  }

  const findSession = () =>
    (cart.payment_collection?.payment_sessions ?? []).find((s) =>
      s.provider_id.startsWith("pp_blockonomics")
    )

  // The plugin's price refresh: re-quotes the active address, or hands out the
  // next one once a settled underpayment leaves a remainder.
  const requote = async () => {
    const res = await fetch(
      MEDUSA + "/store/blockonomics/payment-sessions/" + session.id,
      { method: "POST", headers: { "x-publishable-api-key": KEY } }
    )
    if (!res.ok) throw new Error("Re-quote failed with " + res.status)
    const { payment_session } = await res.json()
    session = { ...session, ...payment_session }
    return session
  }

  // ---- Payment screen ---------------------------------------------------

  const fiat = (amount) =>
    Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
    " " + String(session.data.currency_code).toUpperCase()

  const renderPayment = () => {
    const d = session.data
    const currency = String(d.currency_code).toUpperCase()
    const amount = btc(d.expected_satoshis)
    const uri = "bitcoin:" + d.address + "?amount=" + amount

    $("cart-label").textContent = "Cart " + CART_ID.slice(-6).toUpperCase()
    $("cart-total").textContent = fiat(d.fiat_amount)

    // Settled underpayments are carried in fiat, valued at the rate they were
    // quoted at; the remainder is what this address is quoted for.
    if (d.paid_fiat > 0) {
      $("paid-rows").classList.remove("hidden")
      $("paid-btc").textContent = fiat(d.paid_fiat)
      $("remaining-btc").textContent = fiat(d.expected_fiat)
    } else {
      $("paid-rows").classList.add("hidden")
    }

    $("address").value = d.address
    $("amount").value = amount
    $("rate").textContent = Number(d.btc_price).toLocaleString()
    $("currency").textContent = currency
    $("qr-link").href = uri
    $("wallet-link").href = uri

    $("qr").innerHTML = ""
    qr = new QRCode($("qr"), { text: uri, width: 160, height: 160, correctLevel: QRCode.CorrectLevel.M })

    startTimer(d.price_locked_until)
  }

  const startTimer = (until) => {
    clearInterval(timer)
    const tick = async () => {
      const left = Math.max(Math.floor((until - Date.now()) / 1000), 0)
      $("time-left").textContent =
        String(Math.floor(left / 60)).padStart(2, "0") + ":" + String(left % 60).padStart(2, "0")
      if (left <= 0) {
        clearInterval(timer)
        await refresh()
      }
    }
    tick()
    timer = setInterval(tick, 1000)
  }

  const refresh = async () => {
    const button = $("refresh")
    button.classList.add("spin")
    button.disabled = true
    try {
      await requote()
      renderPayment()
    } catch (error) {
      showError(error.message)
    } finally {
      button.classList.remove("spin")
      button.disabled = false
    }
  }

  // ---- Receipt screen ---------------------------------------------------

  const showReceipt = async (payment) => {
    const d = session.data

    $("payment").classList.add("hidden")
    $("receipt").classList.remove("hidden")
    $("txid").textContent = payment.txid
    $("txid").title = payment.txid

    if (payment.value < d.expected_satoshis) {
      // Short. The shortfall is worth what it was quoted at. The remainder can
      // only be paid once this payment settles and the plugin hands out the
      // next address, so the button waits for that.
      const dueFiat = d.expected_fiat * (1 - payment.value / d.expected_satoshis)
      $("settled").classList.add("hidden")
      $("underpaid").classList.remove("hidden")
      $("due").textContent = fiat(dueFiat)
      renderConfirmations(payment.status, "underpaid-conf")
      await offerRemainder()
      return
    }

    $("underpaid").classList.add("hidden")
    $("settled").classList.remove("hidden")
    renderConfirmations(payment.status)
  }

  // Asks the plugin for the next address. Until the underpayment has settled
  // there is none, and the customer is asked to wait.
  const offerRemainder = async () => {
    const before = session.data.address
    try {
      await requote()
    } catch {}
    const ready = session.data.address !== before && session.data.payment_status === 0
    $("pay-remaining").classList.toggle("hidden", !ready)
    $("underpaid-wait").classList.toggle("hidden", ready)
    if (ready) {
      $("pay-remaining").textContent = "Pay remaining " + fiat(session.data.expected_fiat)
    }
  }

  const renderConfirmations = (status, textId = "conf-text") => {
    ;[0, 1, 2].forEach((i) => {
      const el = $("c" + i)
      el.className = status >= i ? (i === FINAL_CONFIRMATIONS ? "done" : "on") : ""
    })
    $(textId).textContent =
      status >= FINAL_CONFIRMATIONS
        ? "Payment confirmed"
        : status === 1
        ? "1 confirmation, waiting for 1 more"
        : "Seen on the network, waiting for confirmation"
  }

  // The order is placed server-side by the Blockonomics callback. Once the
  // socket reports the payment as confirmed, the cart is checked until it
  // has been completed.
  const watchOrder = () => {
    if (orderPoll) return
    const check = async () => {
      try {
        await fetchCart()
        if (cart.completed_at) {
          clearInterval(orderPoll)
          $("order").textContent = "Order placed"
        }
      } catch {}
    }
    check()
    orderPoll = setInterval(check, 5000)
  }

  $("pay-remaining").addEventListener("click", async () => {
    try {
      await requote()
      $("receipt").classList.add("hidden")
      $("payment").classList.remove("hidden")
      renderPayment()
      connectSocket()
    } catch (error) {
      showError(error.message)
    }
  })

  // ---- WebSocket --------------------------------------------------------

  const connectSocket = () => {
    if (ws) { wsClosed = true; ws.close() }
    wsClosed = false
    const connect = () => {
      ws = new WebSocket(WS_URL + "/payment/" + session.data.address)
      ws.onopen = () => { wsAttempt = 0 }
      ws.onmessage = (event) => {
        let payment
        try { payment = JSON.parse(event.data) } catch { return }
        clearInterval(timer)
        showReceipt(payment)
        if (payment.status >= FINAL_CONFIRMATIONS) {
          wsClosed = true
          ws.close()
          if (payment.value >= session.data.expected_satoshis) {
            watchOrder()
          }
        }
      }
      ws.onclose = () => {
        if (wsClosed) return
        const delay = Math.min(1000 * 2 ** wsAttempt++, 30000)
        setTimeout(connect, delay)
      }
      ws.onerror = () => ws.close()
    }
    connect()
  }

  // ---- Copy to clipboard ------------------------------------------------

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement("textarea")
      area.value = text
      document.body.appendChild(area)
      area.select()
      document.execCommand("copy")
      area.remove()
    }
  }

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const source = $(button.dataset.copy)
      await copyText(source.value ?? source.textContent)
      const box = button.closest(".copy")
      if (box) {
        box.classList.add("is-copied")
        setTimeout(() => box.classList.remove("is-copied"), 1500)
      } else {
        // Bare icon (txid on the receipt): swap it for the check mark briefly.
        const icon = button.innerHTML
        button.innerHTML = ${JSON.stringify(CHECK_ICON)}
        button.style.color = "var(--ok)"
        setTimeout(() => { button.innerHTML = icon; button.style.color = "" }, 1500)
      }
    })
  })

  $("refresh").addEventListener("click", refresh)

  // ---- Boot -------------------------------------------------------------

  const showError = (message) => {
    $("error").textContent = message
    $("error").classList.remove("hidden")
  }

  ;(async () => {
    try {
      await fetchCart()
      session = findSession()
      if (!session) throw new Error("No Blockonomics session on this cart.")

      if (cart.completed_at) {
        $("payment").classList.add("hidden")
        $("receipt").classList.remove("hidden")
        renderConfirmations(FINAL_CONFIRMATIONS)
        watchOrder()
        return
      }

      // Reloaded mid-payment: the active address already has a payment on it,
      // so the receipt is shown from what the callbacks recorded. The socket
      // catches up on the payment's state when it connects.
      const d = session.data
      if (d.payment_status !== 0) {
        await showReceipt({
          txid: d.txid,
          status: d.confirmations,
          value: d.payment_status === 2 ? d.paid_satoshis : d.expected_satoshis,
        })
        connectSocket()
        return
      }

      renderPayment()
      connectSocket()
    } catch (error) {
      showError(error.message)
    }
  })()
</script>
</body>
</html>`

// Icons match the ones the WooCommerce plugin ships.
const COPY_ICON =
  '<svg width="18" height="20" viewBox="0 0 22 24" fill="none" aria-hidden="true"><path d="M15.5 1H3.5C2.4 1 1.5 1.9 1.5 3V17H3.5V3H15.5V1ZM18.5 5H7.5C6.4 5 5.5 5.9 5.5 7V21C5.5 22.1 6.4 23 7.5 23H18.5C19.6 23 20.5 22.1 20.5 21V7C20.5 5.9 19.6 5 18.5 5ZM18.5 21H7.5V7H18.5V21Z" fill="currentColor"/></svg>'
const CHECK_ICON =
  '<svg width="18" height="18" viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M4.05 14a9.86 9.86 0 1 1 19.71 0 9.86 9.86 0 0 1-19.71 0Z" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.52 14l3.29 3.29 5.47-5.48" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const REFRESH_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 4v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const MARK_ICON =
  '<svg width="48" height="48" viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M4.05 14a9.86 9.86 0 1 1 19.71 0 9.86 9.86 0 0 1-19.71 0Z" stroke="currentColor" stroke-width="1.6"/><path d="M9.52 14l3.29 3.29 5.47-5.48" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

async function main() {
  if (!CART_ID) {
    console.error("Pass a cart id: node scripts/checkout-demo.js <cart_id>")
    process.exit(1)
  }

  const publishableKey = await getPublishableKey()
  const html = page(publishableKey)

  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(html)
    })
    .listen(PORT, () => {
      console.log(`Checkout demo for ${CART_ID} on http://localhost:${PORT}`)
    })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
