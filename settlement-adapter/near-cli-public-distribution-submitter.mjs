import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFile=promisify(nodeExecFile);
const PUB=/(?:ed25519|secp256k1):[A-Za-z0-9]+/;
const TX=/\b([1-9A-HJ-NP-Za-km-z]{32,64})\b/;
async function fullAccessKeys({fetchImpl,rpcUrl,contractId}) {
  const r=await fetchImpl(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({jsonrpc:'2.0',id:'ajo-public-distribution-signer-check',method:'query',params:{request_type:'view_access_key_list',finality:'final',account_id:contractId}})});
  if(!r.ok) throw new Error('NEAR RPC could not verify treasury access keys'); const p=await r.json();
  if(p?.error||!Array.isArray(p?.result?.keys)) throw new Error('Finalized FullAccess key evidence is unavailable');
  return p.result.keys.filter(x=>x?.access_key?.permission==='FullAccess').map(x=>x.public_key).filter(x=>typeof x==='string');
}
/** Fixed-method treasury submitter. It never reads or accepts a private key. */
export function createNearCliPublicDistributionSubmitter({fetchImpl=globalThis.fetch,rpcUrl='https://rpc.testnet.fastnear.com',execFileImpl=execFile,timeoutMs=120000}={}) {
  if(rpcUrl!=='https://rpc.testnet.fastnear.com'||typeof fetchImpl!=='function'||typeof execFileImpl!=='function') throw new Error('Public distribution signer must be configured for NEAR testnet');
  return async function submitDistribution({network,contractId,method}={}) {
    if(network!=='testnet'||!/^[a-z0-9._-]{2,64}$/.test(contractId??'')||!['start_public_distribution','continue_public_distribution'].includes(method)) throw new Error('Only the fixed testnet public distribution methods are permitted');
    const keyResult=await execFileImpl('near',['account','get-public-key','from-keychain',contractId,'network-config','testnet'],{timeout:15000,windowsHide:true,maxBuffer:1024*1024});
    const keyText=String(keyResult?.stdout??'')+'\n'+String(keyResult?.stderr??''); const publicKey=keyText.match(PUB)?.[0];
    if(!publicKey) throw new Error('NEAR CLI keychain did not return a treasury public key');
    if(!(await fullAccessKeys({fetchImpl,rpcUrl,contractId})).includes(publicKey)) throw new Error('CLI key is not a finalized FullAccess key for this exact treasury account');
    const args=['contract','call-function','as-transaction',contractId,method,'json-args','{}','prepaid-gas','300 TGas','attached-deposit','0 NEAR','sign-as',contractId,'network-config','testnet','sign-with-keychain','--signer-public-key',publicKey,'send'];
    let result; try { result=await execFileImpl('near',args,{timeout:timeoutMs,windowsHide:true,maxBuffer:2*1024*1024}); }
    catch(e){e.submissionOutcomeUnknown=true;throw e;}
    const output=String(result?.stdout??'')+'\n'+String(result?.stderr??'');
    const txHash=output.match(/transaction\s*(?:id|hash)\s*:\s*([1-9A-HJ-NP-Za-km-z]{32,64})/i)?.[1]??output.match(/explorer\.near\.org\/transactions\/([1-9A-HJ-NP-Za-km-z]{32,64})/i)?.[1];
    if(!txHash){const e=new Error('CLI returned without a recognizable transaction hash; reconcile before retrying');e.submissionOutcomeUnknown=true;throw e;}
    return Object.freeze({txHash,signerPublicKey:publicKey});
  };
}
