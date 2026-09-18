import { MedusaError } from "@medusajs/framework/utils"

export const DEFAULT_BASE_URL = "https://www.blockonomics.co"

type ClientOptions = {
  apiKey: string
  baseUrl?: string
}

/**
 * Thin wrapper around the endpoints of the Blockonomics merchant API that the
 * provider needs. It intentionally has no third-party dependency - the API is a
 * handful of REST calls and Node's global `fetch` covers them.
 */
export class BlockonomicsClient {
  protected readonly apiKey_: string
  protected readonly baseUrl_: string

  constructor({ apiKey, baseUrl }: ClientOptions) {
    this.apiKey_ = apiKey
    this.baseUrl_ = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  }

  /**
   * Generates a new, unused Bitcoin address for a payment. Addresses never
   * expire, so one is generated per payment session and reused across retries.
   */
  async newAddress({
    matchCallback,
    reset,
  }: { matchCallback?: string; reset?: 0 | 1 } = {}): Promise<string> {
    const query: Record<string, string> = { crypto: "BTC" }

    if (matchCallback) {
      query.match_callback = matchCallback
    }

    if (reset) {
      query.reset = String(reset)
    }

    const response = await this.request_<{ address: string }>(
      "POST",
      "/api/new_address",
      query
    )

    if (!response?.address) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Blockonomics did not return a payment address"
      )
    }

    return response.address
  }

  /**
   * Price of 1 BTC in the given fiat currency.
   */
  async getPrice(currencyCode: string): Promise<number> {
    const response = await this.request_<{ price: number }>(
      "GET",
      "/api/price",
      { crypto: "BTC", currency: currencyCode.toUpperCase() }
    )

    if (!response?.price) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Blockonomics did not return a BTC price for ${currencyCode}`
      )
    }

    return response.price
  }

  protected async request_<T>(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string> = {}
  ): Promise<T> {
    const url = new URL(`${this.baseUrl_}${path}`)

    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value)
    }

    let response: Response

    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey_}`,
          "Content-Type": "application/json",
        },
      })
    } catch (error) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Could not reach the Blockonomics API: ${error.message}`
      )
    }

    const body = await response.text()

    if (!response.ok) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Blockonomics API responded with ${response.status} for ${path}: ${body}`
      )
    }

    if (!body) {
      return undefined as T
    }

    try {
      return JSON.parse(body) as T
    } catch (error) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Could not parse the Blockonomics response for ${path}: ${body}`
      )
    }
  }
}
