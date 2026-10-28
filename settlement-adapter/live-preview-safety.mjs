/** Safety boundary for live 1Click preview calls from a testnet-oriented app. */
export function assertLivePreviewRequestAllowed(request) {
  if (!request || typeof request !== 'object' || request.dry !== true) {
    throw new Error('The live-preview safety gate only accepts explicit dry:true requests.');
  }
  const testnetFields = ['recipient', 'refundTo'].filter(field =>
    typeof request[field] === 'string' && request[field].trim().toLowerCase().endsWith('.testnet'));
  if (testnetFields.length) {
    const error = new Error(
      'Live 1Click is not a NEAR testnet simulator. A live preview requires valid mainnet recipient and refund addresses; this request contains NEAR testnet account IDs. No provider request was made.'
    );
    error.code = 'LIVE_1CLICK_TESTNET_ADDRESS_BLOCKED';
    throw error;
  }
}
