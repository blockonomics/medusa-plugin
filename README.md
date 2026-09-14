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
| `confirmations` | `2` | On-chain confirmations before the payment is authorized and the order is placed: `0`, `1`, or `2`. See [Choosing confirmations](#choosing-confirmations). |
| `priceLockSeconds` | `600` | How long the quoted BTC amount stays valid. Once it expires with nothing received, the amount is re-quoted at the current rate. Clamped to 300–1800. |
| `underpaymentTolerance` | `0` | Fraction of the expected amount that may be missing and still count as paid, to absorb rounding and wallet fee deductions. `0.01` allows a 1% shortfall. |
| `overpaymentTolerance` | `0.05` | Excess above which the payment is flagged with `overpaid: true` for manual review. The payment is still authorized. |
| `matchCallback` | - | Substring of the store's callback URL. Set it when the Blockonomics account has more than one store, so addresses are generated for the right one. |
| `baseUrl` | `https://www.blockonomics.co` | Base URL of the Blockonomics API. Only useful for testing against a stub. |

### Choosing confirmations

| Value | Order placed | Risk |
| --- | --- | --- |
| `0` | As soon as the transaction is seen in the mempool | The sender can still double-spend it. Only use for low-value or reversible fulfilment. |
| `1` | After about 10 minutes | Low. |
| `2` | After about 20 minutes | Lowest. Recommended default. |

Capture always happens at 2 confirmations, whichever value you pick.

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

| On-chain state | Payment session status |
| --- | --- |
| Address generated, nothing received | `pending` |
| Less than the expected amount received | `pending_authorization` |
| Expected amount received, below `confirmations` | `pending_authorization` |
| Expected amount received, at or above `confirmations` | `authorized`, order is placed |
| 2 confirmations | `captured` |

The amount received is the sum of the incoming transactions in the address' on-chain history, so the merchant later spending the coins doesn't undo a payment, and a replaced or double-spent transaction drops out. An address paid by several transactions settles once the total is enough.

The payment's confirmations are those of the transactions that make up the amount, not of the most-confirmed one: a small confirmed transaction next to a large unconfirmed one stays below the threshold.

With `confirmations: 0`, an unconfirmed transaction that opted into Replace-By-Fee is not accepted until it confirms, because the sender can still replace it.

The storefront reads the address and amount to show the customer from the payment session's `data`: `address`, `expected_satoshis`, and `price_locked_until`.

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

Test mode addresses are placeholders that the history endpoint rejects. The provider settles test payments from the callback values, so this is expected and needs no workaround.

## License

MIT
