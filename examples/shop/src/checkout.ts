import { randomUUID } from "node:crypto";

export interface Product {
  id: string;
  name: string;
  priceCents: number;
  emoji: string;
}

export const PRODUCTS: readonly Product[] = [
  { id: "mech-keyboard", name: "Mechanical Keyboard", priceCents: 8_900, emoji: "⌨️" },
  { id: "flag-hoodie", name: "Feature Flag Hoodie", priceCents: 4_500, emoji: "🧥" },
  { id: "rubber-duck", name: "Debugging Rubber Duck", priceCents: 1_200, emoji: "🦆" },
];

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface Order {
  orderId: string;
  totalCents: number;
  checkout: "legacy" | "new";
}

/** Failure modes injected into the *new* checkout only, to demo the kill switch. */
export interface Chaos {
  /** Probability (0-1) that a new-checkout request fails. */
  errorRate: number;
  /** Extra latency added to every new-checkout request. */
  extraLatencyMs: number;
}

export const NO_CHAOS: Chaos = { errorRate: 0, extraLatencyMs: 0 };

export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 500,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

export interface CheckoutDeps {
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function priceCart(items: readonly CartItem[]): number {
  if (items.length === 0) throw new CheckoutError("Cart is empty", 400);
  return items.reduce((total, item) => {
    const product = PRODUCTS.find((p) => p.id === item.productId);
    if (!product) throw new CheckoutError(`Unknown product: ${item.productId}`, 400);
    return total + product.priceCents * item.quantity;
  }, 0);
}

/** Simulated payment-provider round-trip. */
function processingTime(random: () => number, baseMs: number, jitterMs: number): number {
  return Math.round(baseMs + random() * jitterMs);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The battle-tested multi-step checkout. */
export async function legacyCheckout(
  items: readonly CartItem[],
  deps: CheckoutDeps = {},
): Promise<Order> {
  const random = deps.random ?? Math.random;
  const totalCents = priceCart(items);
  await (deps.sleep ?? defaultSleep)(processingTime(random, 60, 40));
  return { orderId: randomUUID(), totalCents, checkout: "legacy" };
}

/**
 * The new one-page checkout: faster and with a bundle discount, but new code.
 * This is the change FlagGuard rolls out gradually.
 */
export async function newCheckout(
  items: readonly CartItem[],
  chaos: Chaos = NO_CHAOS,
  deps: CheckoutDeps = {},
): Promise<Order> {
  const random = deps.random ?? Math.random;
  const subtotal = priceCart(items);
  const units = items.reduce((n, item) => n + item.quantity, 0);
  const totalCents = units >= 3 ? Math.round(subtotal * 0.9) : subtotal; // 10% bundle discount

  await (deps.sleep ?? defaultSleep)(processingTime(random, 35, 25) + chaos.extraLatencyMs);
  if (random() < chaos.errorRate) {
    throw new CheckoutError("Payment session could not be created", 500);
  }
  return { orderId: randomUUID(), totalCents, checkout: "new" };
}

export interface SavedCard {
  customerId: string;
  paymentMethodId: string;
}

/** Payment provider used for one-click payments with a saved card. */
const PAYMENTS_API = process.env.PAYMENTS_API_URL ?? "https://api.payments.example/v1";

/**
 * Express checkout: charge the customer's saved card in one click, skipping the
 * payment form entirely.
 */
export async function expressCheckout(items: readonly CartItem[], card: SavedCard): Promise<Order> {
  const totalCents = priceCart(items);
  const response = await fetch(`${PAYMENTS_API}/charges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: totalCents,
      currency: "usd",
      customer: card.customerId,
      payment_method: card.paymentMethodId,
      confirm: true,
    }),
  });
  if (!response.ok) throw new CheckoutError("Card was declined", 500);
  const charge = (await response.json()) as { id: string };
  return { orderId: charge.id, totalCents, checkout: "new" };
}
