import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { requestLiveOneClickPreview } from './live-preview-runner.mjs';
async function main() {
  const recipient = process.env.AJO_LIVE_PREVIEW_RECIPIENT?.trim();
  const refundTo = process.env.AJO_LIVE_PREVIEW_REFUND_TO?.trim();
  const amount = process.env.AJO_LIVE_PREVIEW_AMOUNT?.trim() || '1000000';
  if (!recipient || !refundTo) { console.error('Live 1Click preview not run. Set AJO_LIVE_PREVIEW_RECIPIENT and AJO_LIVE_PREVIEW_REFUND_TO to appropriate MAINNET addresses locally. Do not use .testnet accounts.'); process.exitCode = 2; return; }
  try { console.log(JSON.stringify(await requestLiveOneClickPreview({ recipient, refundTo, amount }), null, 2)); }
  catch (error) { console.error(JSON.stringify({ status: 'LIVE_PREVIEW_FAILED', error: String(error?.code ?? error?.name ?? 'Error'), message: String(error?.message ?? 'Preview failed').slice(0, 280), note: 'No committed quote or deposit instruction was requested.' }, null, 2)); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();