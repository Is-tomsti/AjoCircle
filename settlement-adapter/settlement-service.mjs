import { parseOneClickStatus } from './oneclick.mjs';

export async function verifyPendingIntentDelivery({ store, statusClient, intentId } = {}) {
  if (!store || typeof store.getIntent !== 'function'
      || typeof store.claimVerifiedDelivery !== 'function') {
    throw new Error('A trusted settlement store is required');
  }
  if (!statusClient || typeof statusClient.getStatus !== 'function') {
    throw new Error('A configured 1Click status client is required');
  }
  if (typeof intentId !== 'string' || !intentId.trim()) {
    throw new Error('A stored intent ID is required');
  }

  // Resolve all payment details from the server-side record, never from request-body fields.
  const trustedIntent = store.getIntent(intentId.trim());
  if (!trustedIntent) throw new Error('Pending intent was not found');
  if (trustedIntent.status !== 'PENDING') {
    throw new Error(`Intent cannot be checked from status ${trustedIntent.status}`);
  }

  const observed = await statusClient.getStatus({
    depositAddress: trustedIntent.depositAddress,
  });
  // A real OneClickStatusClient already parses its response; parsing again is not needed.
  // Injected clients may return the documented JSON payload, which is parsed here for tests/adapters.
  const normalized = observed && typeof observed.amountOut === 'bigint'
    && Array.isArray(observed.destinationTxHashes)
    ? observed
    : parseOneClickStatus(observed);

  return store.claimVerifiedDelivery(trustedIntent.intentId, normalized);
}
