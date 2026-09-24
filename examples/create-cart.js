/**
 * Creates a cart with a Blockonomics payment session and prints its id, ready
 * to hand to checkout-page.js. Stands in for the storefront's cart and
 * checkout steps, so the payment screen can be exercised on its own.
 *
 *   MEDUSA_URL=https://your-store.com \
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... \
 *   node examples/create-cart.js
 *
 * It signs in as an admin only to read a publishable key; everything after
 * that goes through the Store API, the way a storefront would.
 *
 * Zero dependencies; needs Node 18+ for global fetch.
 */

const MEDUSA = process.env.MEDUSA_URL ?? "http://localhost:9000"
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@medusa.local"
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "supersecret"
const PROVIDER = process.env.PROVIDER ?? "pp_blockonomics_blockonomics"
const REGION_ID = process.env.REGION_ID ?? ""

const die = (msg, extra) => {
  console.error(`\nERROR: ${msg}`)
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2))
  process.exit(1)
}

async function json(url, init = {}) {
  const res = await fetch(url, init)
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    die(`${init.method ?? "GET"} ${url} returned non-JSON (HTTP ${res.status})`, text.slice(0, 400))
  }
  if (!res.ok) die(`${init.method ?? "GET"} ${url} failed (HTTP ${res.status})`, body)
  return body
}

async function main() {
  console.log(`backend: ${MEDUSA}`)

  const auth = await json(`${MEDUSA}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
  if (!auth.token) die("admin login failed - check ADMIN_EMAIL / ADMIN_PASSWORD", auth)

  const keys = await json(`${MEDUSA}/admin/api-keys?type=publishable&limit=1`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  })
  const pk = keys.api_keys?.[0]?.token
  if (!pk) die("no publishable API key found - create one in Settings > Publishable API Keys")
  console.log(`publishable key: ${pk.slice(0, 12)}...`)

  const H = { "Content-Type": "application/json", "x-publishable-api-key": pk }

  const { regions } = await json(`${MEDUSA}/store/regions`, { headers: H })
  if (!regions?.length) die("no regions found")
  const region = REGION_ID
    ? regions.find((r) => r.id === REGION_ID)
    : regions[0]
  if (!region) {
    die(
      `region ${REGION_ID} not found. Available: ` +
        regions.map((r) => `${r.name} (${r.id})`).join(", ")
    )
  }
  if (!REGION_ID && regions.length > 1) {
    console.log(
      `note: ${regions.length} regions exist; using the first. ` +
        "Set REGION_ID to choose another."
    )
  }
  console.log(`region: ${region.name} (${region.id}, ${region.currency_code})`)

  const { products } = await json(
    `${MEDUSA}/store/products?region_id=${region.id}&limit=50` +
      "&fields=id,title,*variants,*variants.calculated_price",
    { headers: H }
  )

  // A variant with no price in the region's currency cannot be added to a
  // cart, so skip to one that has been priced rather than failing later on.
  let product, variant
  for (const p of products ?? []) {
    const priced = (p.variants ?? []).find(
      (v) => v.calculated_price?.calculated_amount != null
    )
    if (priced) {
      product = p
      variant = priced
      break
    }
  }
  const currency = region.currency_code.toUpperCase()
  if (!variant) {
    die(
      products?.length
        ? `no variant is priced in ${currency}; add prices for region "${region.name}"`
        : "no products found - is the publishable key linked to a sales channel with products?"
    )
  }
  console.log(
    `product: ${product.title} / ${variant.title} (${variant.id})` +
      ` - ${variant.calculated_price.calculated_amount} ${currency}`
  )

  const { cart } = await json(`${MEDUSA}/store/carts`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ region_id: region.id, email: "test@example.com" }),
  })
  console.log(`cart: ${cart.id}`)

  await json(`${MEDUSA}/store/carts/${cart.id}/line-items`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ variant_id: variant.id, quantity: 1 }),
  })
  console.log("line item added")

  const { shipping_options } = await json(
    `${MEDUSA}/store/shipping-options?cart_id=${cart.id}`,
    { headers: H }
  )
  if (shipping_options?.length) {
    await json(`${MEDUSA}/store/carts/${cart.id}/shipping-methods`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ option_id: shipping_options[0].id }),
    })
    console.log(`shipping: ${shipping_options[0].name}`)
  } else {
    console.log("WARNING: no shipping options for this region - the order may not be completable")
  }

  const { payment_collection } = await json(`${MEDUSA}/store/payment-collections`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ cart_id: cart.id }),
  })

  const created = await json(
    `${MEDUSA}/store/payment-collections/${payment_collection.id}/payment-sessions`,
    { method: "POST", headers: H, body: JSON.stringify({ provider_id: PROVIDER }) }
  )

  const sessions = created.payment_collection?.payment_sessions ?? []
  const session = sessions[sessions.length - 1]
  if (!session) die("no payment session created", created)
  const d = session.data ?? {}
  if (!d.address) {
    die(
      `session has no Bitcoin address - is "${PROVIDER}" enabled on region "${region.name}"?`,
      session
    )
  }

  console.log("\n" + "-".repeat(52))
  console.log(`address     ${d.address}`)
  console.log(`satoshis    ${d.expected_satoshis}`)
  console.log(`BTC         ${(d.expected_satoshis / 1e8).toFixed(8)}`)
  console.log(`fiat        ${d.expected_fiat} ${currency}`)
  console.log(`btc_price   ${d.btc_price}`)
  console.log(`status      ${d.payment_status}`)
  console.log(`lock until  ${new Date(d.price_locked_until).toISOString()}`)
  console.log("-".repeat(52))
  console.log(`\nbitcoin:${d.address}?amount=${(d.expected_satoshis / 1e8).toFixed(8)}`)
  console.log(`\nNow open the visual checkout:\n  node examples/checkout-page.js ${cart.id}`)
}

main().catch((e) => die(e.message))
