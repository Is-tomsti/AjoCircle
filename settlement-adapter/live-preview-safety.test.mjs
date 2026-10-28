import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLivePreviewRequestAllowed } from './live-preview-safety.mjs';

const base = { dry: true, originAsset: 'nep141:usdt.tether-token.near', destinationAsset: 'nep141:wrap.near', amount: '1000000' };

test('blocks live previews using a NEAR testnet recipient before provider access', () => {
  assert.throws(() => assertLivePreviewRequestAllowed({ ...base, recipient: 'ajotest1.testnet', refundTo: 'alice.near' }), error => {
    assert.equal(error.code, 'LIVE_1CLICK_TESTNET_ADDRESS_BLOCKED');
    assert.match(error.message, /not a NEAR testnet simulator/);
    return true;
  });
});

test('blocks live previews using a NEAR testnet refund account before provider access', () => {
  assert.throws(() => assertLivePreviewRequestAllowed({ ...base, recipient: 'alice.near', refundTo: 'ajotest1.testnet' }), error => {
    assert.equal(error.code, 'LIVE_1CLICK_TESTNET_ADDRESS_BLOCKED');
    return true;
  });
});

test('allows dry live-preview requests whose addresses are not NEAR testnet accounts', () => {
  assert.doesNotThrow(() => assertLivePreviewRequestAllowed({ ...base, recipient: 'alice.near', refundTo: 'alice.near' }));
  assert.doesNotThrow(() => assertLivePreviewRequestAllowed({ ...base, recipient: 'alice.near', refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D' }));
});

test('requires explicit dry:true for this live-preview safety gate', () => {
  assert.throws(() => assertLivePreviewRequestAllowed({ ...base, dry: false }), /explicit dry:true/);
});
