# medusa-payment-blockonomics

Accept Bitcoin payments in [Medusa](https://medusajs.com) v2 through [Blockonomics](https://www.blockonomics.co). Payments go straight to the merchant's own wallet: Blockonomics generates a fresh address for each checkout and notifies Medusa as the transaction is seen and confirmed on-chain.

Blockonomics never holds funds. That makes refunds a manual step, covered under [Refunds](#refunds). Read that section before going live.

## Requirements

- Medusa `2.19.0` or later
- A [Blockonomics](https://www.blockonomics.co) account with a store and a wallet (xPub) attached
- A Medusa server reachable from the internet, so Blockonomics can deliver callbacks

## Install

```bash
npm install medusa-payment-blockonomics
```

## Configure

### 1. Register the plugin and the provider

Add the plugin to `plugins`, then register the provider in the Payment Module:

```ts
// medusa-config.ts
import { defineConfig, loadEnv } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "development", process.cwd())

module.exports = defineConfig({
  // ...
  plugins: [
    {
      resolve: "medusa-payment-blockonomics",
      options: {},
    },
  ],
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-blockonomics/providers/blockonomics",
            id: "blockonomics",
            options: {
              apiKey: process.env.BLOCKONOMICS_API_KEY,
              callbackSecret: process.env.BLOCKONOMICS_CALLBACK_SECRET,
              confirmations: 2,
            },
          },
        ],
      },
    },
  ],
})
```

Both entries are required. The `plugins` entry loads the callback route; the provider entry loads the payment provider. Without the `plugins` entry, checkout works but callbacks return `404`, and no payment ever completes.

```bash
# .env
BLOCKONOMICS_API_KEY=your_api_key
BLOCKONOMICS_CALLBACK_SECRET=a_long_random_string
```

Generate the secret yourself, for example with `openssl rand -hex 32`. It is not issued by Blockonomics.

### 2. Set the callback URL in Blockonomics

In the Blockonomics dashboard, open **Stores**, edit the store, and set its callback URL to:

```
https://your-store.com/hooks/blockonomics/blockonomics_blockonomics?secret=YOUR_CALLBACK_SECRET
```

Get this exactly right. A wrong URL fails silently: callbacks arrive, are rejected, and orders stay unpaid.

- The path is `/hooks/blockonomics/blockonomics_{id}`, where `{id}` is the provider's `id` in `medusa-config.ts`. With `id: "blockonomics"` that gives `blockonomics_blockonomics`. If you change the `id`, change the URL.
- `secret` must equal `BLOCKONOMICS_CALLBACK_SECRET`. Callbacks with a missing or different secret are logged and ignored.
- Use `/hooks/blockonomics/...`, not Medusa's `/hooks/payment/...`. Blockonomics sends callbacks as `GET` requests, which Medusa's own endpoint does not accept.

### 3. Enable the provider in a region

In the Medusa admin, go to **Settings → Regions**, edit the region, and add **Blockonomics** (`pp_blockonomics_blockonomics`) to its payment providers.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | - | **Required.** API key of the Blockonomics merchant account. |
| `callbackSecret` | - | **Required.** Secret on the store's callback URL. Callbacks without it are ignored. |
| `confirmations` | `2` | On-chain confirmations a callback has to report before the payment is taken as settled and the order is placed: `0`, `1`, or `2`. See [Choosing confirmations](#choosing-confirmations). |
| `priceLockSeconds` | `600` | How long the quoted BTC amount stays valid. Once it expires with nothing received, the amount is re-quoted at the current rate. Clamped to 300–1800. |
| `underpaymentTolerance` | `0` | Fraction of the expected amount that may be missing and still count as paid, to absorb rounding and wallet fee deductions. `0.01` allows a 1% shortfall. Blockonomics for WooCommerce calls this underpayment slack. |
| `overpaymentTolerance` | `0.05` | Excess above which the payment is flagged with `overpaid: true` for manual review. The payment still settles. |
| `matchCallback` | - | Substring of the store's callback URL. Set it when the Blockonomics account has more than one store, so addresses are generated for the right one. |
| `baseUrl` | `https://www.blockonomics.co` | Base URL of the Blockonomics API. Only useful for testing against a stub. |

### Choosing confirmations

| Value | Order placed | Risk |
| --- | --- | --- |
| `0` | As soon as the transaction is seen in the mempool | The sender can still double-spend it. Only use for low-value or reversible fulfilment. |
| `1` | After about 10 minutes | Low. |
| `2` | After about 20 minutes | Lowest. Recommended default. |

The payment is captured as soon as it settles, whichever value you pick, the way Blockonomics for WooCommerce completes the order at its network confirmation setting.

Unconfirmed transactions that opted into Replace-By-Fee are never treated as paid, even with `confirmations: 0`, because the sender can still replace them.

### Offering both instant and secure checkout

There is no settings screen for provider options, but you can register the provider twice under different ids and choose between them per region in the admin:

```ts
// medusa-config.ts
providers: [
  {
    resolve: "medusa-payment-blockonomics/providers/blockonomics",
    id: "instant",
    options: {
      apiKey: process.env.BLOCKONOMICS_API_KEY,
      callbackSecret: process.env.BLOCKONOMICS_CALLBACK_SECRET,
      confirmations: 0,
    },
  },
  {
    resolve: "medusa-payment-blockonomics/providers/blockonomics",
    id: "secure",
    options: {
      apiKey: process.env.BLOCKONOMICS_API_KEY,
      callbackSecret: process.env.BLOCKONOMICS_CALLBACK_SECRET,
      confirmations: 2,
    },
  },
]
```

These register as `pp_blockonomics_instant` and `pp_blockonomics_secure`. Each needs its own callback URL, so use a separate Blockonomics store for each, with `matchCallback` set to tell them apart:

```
https://your-store.com/hooks/blockonomics/blockonomics_instant?secret=...
https://your-store.com/hooks/blockonomics/blockonomics_secure?secret=...
```

## Payment lifecycle

The provider follows the payment model of the Blockonomics WooCommerce plugin. Every address handed out for a session is a payment with its own fiat quote, and the callback that reaches `confirmations` settles it:

| Callback | Payment | Payment session status |
| --- | --- | --- |
| None yet | `new` - the quote can still be refreshed | `pending` |
| Below `confirmations` | `in progress` - address and quote are frozen | `pending_authorization` |
| At or above `confirmations`, amount covered | `settled` | `captured`, order is placed |
| At or above `confirmations`, amount short | `settled`, underpaid | `pending_authorization` |

What a settled payment paid is recorded in satoshis and in fiat, valued at the rate that address was quoted at: a customer who sent 40% of the BTC asked for has paid 40% of the fiat, whatever the rate has done since.

**Underpayments.** The remainder in fiat is quoted on a fresh address at the current rate the next time the quote is refreshed (see [Re-quoting the amount](#re-quoting-the-amount)). The settled address stays on the session as the record of the partial payment. The order is placed once the last address settles in full. Nothing is refunded automatically; an overpayment is flagged with `overpaid: true` and settles.

A settled address ignores further callbacks. An unconfirmed transaction that opted into Replace-By-Fee only has its transaction id recorded, since the sender can still cancel it.

## Storefront

There is no hosted payment page. The storefront shows the customer where to send Bitcoin, using the payment session's `data`:

| Field | Description |
| --- | --- |
| `address` | Bitcoin address to pay. |
| `expected_satoshis` | Amount to send to it, in satoshis. Divide by `1e8` for BTC. |
| `expected_fiat` | The same amount in the cart's currency: the order total less what earlier addresses settled. |
| `fiat_amount` | The order total. |
| `paid_fiat` | Settled so far, over all addresses of the session. `0` until an underpayment settles. |
| `btc_price` | Rate the amount was quoted at. |
| `price_locked_until` | Unix milliseconds until the quote expires. |
| `payment_status` | `0` nothing seen, `1` payment in progress, `2` settled. |
| `confirmations` | Confirmations the latest callback reported. |
| `txid` | Transaction id, once one has been seen. |
| `payments` | Every address of the session with the fields above, oldest first. |

The flow the Blockonomics WooCommerce plugin uses, and what to build:

1. Show a QR code of `bitcoin:{address}?amount={btc}`, an "Open in wallet" link to the same URI, and the address and amount as copyable fields.
2. Count down to `price_locked_until`. When it runs out, re-quote through the plugin's store route below and update the amount, rate, and QR code. Do not create a new payment session for this: Medusa replaces the session, which hands the customer a new address.
3. Open `wss://www.blockonomics.co/payment/{address}`. The first message means the payment has been seen: switch to a receipt screen with the transaction id. Messages carry `status` (`0` unconfirmed, `1`, `2` confirmed), `value` in satoshis, and `txid`.
4. If `value` is short of `expected_satoshis`, show the shortfall in fiat (`expected_fiat * (1 - value / expected_satoshis)`). The remainder can be paid once the underpayment has confirmed: call the re-quote route, and when it comes back with a new `address`, return to the payment screen for it. Show `paid_fiat` and `expected_fiat` as the paid and remaining amounts.
5. Do not complete the cart from the storefront. The callback settles the session at the configured confirmations, and Medusa places the order. The receipt screen can read the cart until `completed_at` is set.

### Re-quoting the amount

```
POST /store/blockonomics/payment-sessions/{payment_session_id}
x-publishable-api-key: pk_...
```

Runs the provider's price refresh on the session, what the WooCommerce plugin does when its checkout page loads:

- nothing seen yet: the amount is re-quoted at the current rate once the price lock has expired. The address is kept.
- payment in progress: nothing changes; the customer sent what they were quoted.
- settled underpayment: a new address is handed out for the remainder at the current rate. The response carries the new `address`.

```json
{
  "payment_session": {
    "id": "payses_...",
    "status": "pending",
    "data": { "address": "...", "expected_fiat": 20, "expected_satoshis": 30149, "btc_price": 66338.6, "price_locked_until": 1789701331086, "payment_status": 0 }
  }
}
```

A complete reference page is in the plugin's repository under `examples/`.

## Refunds

Bitcoin payments are irreversible, and Blockonomics holds no funds, so refunds cannot go through the provider. **Clicking Refund in the Medusa admin throws an error.**

To refund a customer, send the amount from the wallet that received the payment, and record the refund outside of Medusa.

## Testing

Blockonomics has a test mode that fires real callbacks without moving funds.

1. Expose your local server with a tunnel such as ngrok, and set the store's callback URL to the tunnel address.
2. In the Blockonomics dashboard, enable **Testmode** on the store.
3. Place an order in your storefront and choose Blockonomics.
4. On the [Test Bench](https://www.blockonomics.co/dashboard#/test-bench), send the quoted amount from the **Test Bitcoin Wallet**.

Callbacks arrive with status `0` immediately, `1` after about 5 minutes, and `2` after about 10.


## License

MIT
