import test from 'node:test';
import assert from 'node:assert/strict';
import { createNearCliPayoutSubmitter } from './near-cli-payout-submitter.mjs';

const CONTRACT = 'ajo-demo-fresh.testnet';
const KEY = 'ed25519:6XfmmT4cLVZYF4WiyVuayppQj5x3ynKLCLHZx9NwkQTX';
const HASH = '11111111111111111111111111111111111111111111';
const PLAN = { network: 'testnet', contractId: CONTRACT, round: 2 };

function rpcWith(keys) {
  return async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.method, 'query');
    assert.equal(request.params.request_type, 'view_access_key_list');
    assert.equal(request.params.account_id, CONTRACT);
    return { ok: true, async json() { return { result: { keys } }; } };
  };
}

test('CLI payout submitter verifies the keychain public key is on-chain FullAccess before fixed payout call', async () => {
  const calls = [];
  const submit = createNearCliPayoutSubmitter({
    fetchImpl: rpcWith([{ public_key: KEY, access_key: { permission: 'FullAccess' } }]),
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      if (calls.length === 1) return { stdout: KEY, stderr: '' };
      return { stdout: `Transaction ID: ${HASH}`, stderr: '' };
    },
  });
  const result = await submit(PLAN);
  assert.equal(result.txHash, HASH);
  assert.equal(result.signerPublicKey, KEY);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].file, 'near');
  assert.deepEqual(calls[1].args, [
    'contract', 'call-function', 'as-transaction', CONTRACT,
    'release_payout', 'json-args', '{}',
    'prepaid-gas', '300 TGas', 'attached-deposit', '0 NEAR',
    'sign-as', CONTRACT, 'network-config', 'testnet',
    'sign-with-keychain', '--signer-public-key', KEY, 'send',
  ]);
});

test('CLI payout submitter refuses a key that is not an on-chain FullAccess key', async () => {
  let sent = false;
  const submit = createNearCliPayoutSubmitter({
    fetchImpl: rpcWith([{ public_key: KEY, access_key: { permission: { FunctionCall: { receiver_id: CONTRACT, method_names: [] } } } }]),
    execFileImpl: async (_file, args) => {
      if (args[0] === 'account') return { stdout: KEY, stderr: '' };
      sent = true;
      return { stdout: `Transaction ID: ${HASH}`, stderr: '' };
    },
  });
  await assert.rejects(submit(PLAN), /not a finalized FullAccess key/);
  assert.equal(sent, false);
});

test('CLI payout submitter marks an unparseable send result as unknown', async () => {
  const submit = createNearCliPayoutSubmitter({
    fetchImpl: rpcWith([{ public_key: KEY, access_key: { permission: 'FullAccess' } }]),
    execFileImpl: async (_file, args) => args[0] === 'account'
      ? { stdout: KEY, stderr: '' }
      : { stdout: 'submission completed but no transaction id printed', stderr: '' },
  });
  await assert.rejects(submit(PLAN), error => error.submissionOutcomeUnknown === true);
});
