// Minimal in-memory conversation memory. The pipeline is otherwise fully
// stateless (each message routed independently), but a short reply like "yes
// please" only makes sense in light of what the bot just offered — so this
// remembers exactly one thing: an outstanding pricing offer, keyed by the
// widget's per-session id.
//
// PoC-scope deliberately: a plain in-memory Map resets on restart and doesn't
// survive multiple server instances. Fine for a single-process demo; revisit
// (e.g. a short-TTL external store) if this graduates past Phase 1.

interface PendingOffer {
  serviceIds: string[];
  updatedAt: number;
}

const OFFER_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for a normal reply gap

const pendingOffers = new Map<string, PendingOffer>();

// The service(s) discussed if a pricing offer is still outstanding for this
// session, or undefined if there's nothing pending (no session id, no offer
// made, visitor already used it, or it's gone stale).
export function getPendingPricingOffer(sessionId: string | undefined): string[] | undefined {
  if (!sessionId) return undefined;
  const offer = pendingOffers.get(sessionId);
  if (!offer) return undefined;
  if (Date.now() - offer.updatedAt > OFFER_TTL_MS) {
    pendingOffers.delete(sessionId);
    return undefined;
  }
  return offer.serviceIds;
}

export function setPendingPricingOffer(sessionId: string | undefined, serviceIds: string[]): void {
  if (!sessionId || !serviceIds.length) return;
  pendingOffers.set(sessionId, { serviceIds, updatedAt: Date.now() });
}

export function clearPendingPricingOffer(sessionId: string | undefined): void {
  if (!sessionId) return;
  pendingOffers.delete(sessionId);
}
