import { NearContractReadClient } from './near-contract-read-client.mjs';
import { inspectPublicDistribution } from './public-distribution-assessment.mjs';

export const PUBLIC_DISTRIBUTION_EXECUTION_PATH = '/api/agent/public-distribution-execution';
const ACCOUNT = /^[a-z0-9._-]{2,64}$/;
const TX = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
function sendJson(res, status, body) { res.statusCode=status; res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-content-type-options','nosniff'); res.setHeader('referrer-policy','no-referrer'); res.end(JSON.stringify(body)); }
async function readBody(req) {
  if (req.body && typeof req.body==='object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw='', size=0; for await (const chunk of req) { const s=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk); size+=Buffer.byteLength(s); if(size>16*1024) throw new Error('BODY_TOO_LARGE'); raw+=s; }
  try { return JSON.parse(raw); } catch { throw new Error('INVALID_JSON'); }
}
async function verifyTx({fetchImpl,rpcUrl,contractId,txHash,method}) {
  if(!TX.test(txHash??'')) throw new Error('Transaction hash is invalid');
  const response=await fetchImpl(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({jsonrpc:'2.0',id:'ajo-public-distribution-tx-check',method:'tx',params:[txHash,contractId]})});
  if(!response.ok) throw new Error('Finalized NEAR RPC could not verify distribution transaction');
  const payload=await response.json(), result=payload?.result, tx=result?.transaction;
  if(payload?.error||!tx||!result?.status||tx.hash!==txHash||tx.signer_id!==contractId||tx.receiver_id!==contractId) throw new Error('Finalized transaction evidence does not match the designated contract signer');
  if(!Array.isArray(tx.actions)||tx.actions.length!==1||!tx.actions[0]?.FunctionCall) throw new Error('Distribution transaction must contain one fixed function call');
  const call=tx.actions[0].FunctionCall; let args; try{args=JSON.parse(Buffer.from(call.args??'','base64').toString('utf8'));}catch{throw new Error('Distribution transaction arguments are invalid');}
  if(call.method_name!==method||JSON.stringify(args)!=='{}'||String(call.deposit??'0')!=='0') throw new Error(`Transaction does not match ${method} with empty arguments and zero deposit`);
  const transactionFailed = !(Object.hasOwn(result.status,'SuccessValue')||Object.hasOwn(result.status,'SuccessReceiptId'))
    || Boolean(result.status.Failure)
    || Boolean(result.transaction_outcome?.outcome?.status?.Failure)
    || (Array.isArray(result.receipts_outcome)&&result.receipts_outcome.some(x=>Boolean(x?.outcome?.status?.Failure)));
  return {txHash,methodName:method,signerId:tx.signer_id,receiverId:tx.receiver_id,outcome:transactionFailed?'VERIFIED_FAILURE':'VERIFIED_SUCCESS'};
}

/** Authenticated, dual-operator testnet execution. It submits one transfer transaction per action. */
export function createPublicDistributionExecutionHandler({store,executionStore,authenticateRequest,verifyContract,submitDistribution,rpcUrl='https://rpc.testnet.fastnear.com',fetchImpl=globalThis.fetch,clock=()=>Date.now()}={}) {
  if(!store||typeof store.findMembershipForPrincipal!=='function'||typeof store.getVerifiedContractBinding!=='function'||typeof store.getCircleScheduleParityContext!=='function') throw new Error('Trusted application store is required');
  if(!executionStore||typeof executionStore.prepare!=='function'||typeof executionStore.authorize!=='function'||typeof executionStore.get!=='function') throw new Error('Trusted public distribution ledger is required');
  if(typeof authenticateRequest!=='function'||typeof verifyContract!=='function'||typeof submitDistribution!=='function'||typeof fetchImpl!=='function') throw new Error('Trusted execution dependencies are required');
  if(rpcUrl!=='https://rpc.testnet.fastnear.com') throw new Error('Public distribution is testnet-only');
  const inFlight=new Set();

  async function getAssessment(circleId) {
    const binding=store.getVerifiedContractBinding({circleId}); const parity=store.getCircleScheduleParityContext({circleId});
    if(!binding||binding.network!=='testnet'||!binding.contractId||!parity?.ready||!parity.local||parity.local.contractId!==binding.contractId||parity.local.mode!=='PROTECTED_PUBLIC') throw new Error('Verified testnet binding and exact public-circle schedule parity are required');
    const live=await verifyContract({contractId:binding.contractId,expectedMode:parity.local.mode,rpcUrl,fetchImpl});
    const age=clock()-Date.parse(live?.verifiedAt??'');
    if(live?.verified!==true||live.network!=='testnet'||live.contractId!==binding.contractId||live.codeSha256!==binding.codeSha256||live.mode!=='ProtectedPublic'||!Number.isFinite(age)||age<0||age>60_000) throw new Error('Fresh finalized contract code hash does not match the approved binding');
    const client=new NearContractReadClient({rpcUrl,contractId:binding.contractId,fetchImpl});
    const assessment=await inspectPublicDistribution({client,binding,local:parity.local,live});
    return {binding,parity,live,client,assessment};
  }

  return async function publicDistributionExecutionHandler(req,res) {
    if(req.method!=='POST'){res.setHeader('allow','POST');return sendJson(res,405,{error:'METHOD_NOT_ALLOWED'});}
    let principal; try{principal=await authenticateRequest(req);}catch{principal=null;}
    if(!principal||typeof principal.subject!=='string'||!principal.subject.trim()) return sendJson(res,401,{error:'UNAUTHENTICATED'});
    let body; try{body=await readBody(req);}catch(e){return sendJson(res,e.message==='BODY_TOO_LARGE'?413:400,{error:e.message==='BODY_TOO_LARGE'?'BODY_TOO_LARGE':'INVALID_JSON'});}
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['action','circleId','planId','confirmation'].includes(k))||!['prepare','authorize','start','continue','status'].includes(body.action)) return sendJson(res,400,{error:'INVALID_REQUEST'});
    if(body.action==='prepare'&&!(typeof body.circleId==='string'&&body.circleId.trim()&&body.circleId.length<=200)) return sendJson(res,400,{error:'INVALID_REQUEST'});
    if(body.action!=='prepare'&&!(typeof body.planId==='string'&&body.planId.trim())) return sendJson(res,400,{error:'INVALID_REQUEST'});
    if(['authorize','start','continue'].includes(body.action)&&typeof body.confirmation!=='string') return sendJson(res,400,{error:'INVALID_REQUEST'});
    const plan=body.action==='prepare'?null:executionStore.get(body.planId.trim());
    if(body.action!=='prepare'&&!plan) return sendJson(res,404,{error:'DISTRIBUTION_PLAN_NOT_FOUND'});
    const circleId=body.action==='prepare'?body.circleId.trim():plan.circleId;
    const membership=store.findMembershipForPrincipal({principalId:principal.subject,circleId});
    if(!membership||membership.status!=='ACTIVE') return sendJson(res,403,{error:'ACTIVE_MEMBERSHIP_REQUIRED'});
    if(body.action==='prepare') {
      try {
        const {binding,live,assessment}=await getAssessment(circleId);
        if(assessment.status!=='READY_TO_START'||assessment.transactionSubmitted!==false) return sendJson(res,409,{error:'DISTRIBUTION_NOT_READY',assessment,transactionSubmitted:false});
        const entries=Object.entries(assessment.verifiedTotals).map(([member,amountYocto])=>({member,amountYocto})).sort((a,b)=>a.member<b.member?-1:a.member>b.member?1:0);
        const total=entries.reduce((sum,x)=>sum+BigInt(x.amountYocto),0n).toString();
        const saved=executionStore.prepare({circleId,preparedBy:principal.subject,contractId:binding.contractId,codeSha256:live.codeSha256,round:live.currentRound,plan:entries,totalYocto:total,network:'testnet'});
        return sendJson(res,200,{plan:saved,authorizationPhrase:`AUTHORIZE TESTNET DISTRIBUTION ${saved.contractId} ROUND ${saved.round} TOTAL ${saved.totalYocto} YOCTO`,transactionSubmitted:false,note:'Prepared a durable plan only. No transaction was submitted.'});
      } catch(e){return sendJson(res,409,{error:'DISTRIBUTION_PREFLIGHT_FAILED',message:e.message,transactionSubmitted:false});}
    }
    if(body.action==='authorize') {
      try {
        const {assessment,live}=await getAssessment(circleId);
        if(assessment.status!=='READY_TO_START'||assessment.plan.length!==0||live.currentRound!==plan.round) return sendJson(res,409,{error:'DISTRIBUTION_STATE_MISMATCH',assessment,message:'Only a fresh, not-yet-started final-round distribution plan can receive second-member authorization.'});
        const saved=executionStore.authorize(plan.id,{actor:principal.subject,confirmation:body.confirmation});
        return sendJson(res,200,{plan:saved,transactionSubmitted:false,note:'Independent second-member approval recorded. No transaction submitted.'});
      } catch(e){return sendJson(res,409,{error:'DISTRIBUTION_AUTHORIZATION_REJECTED',message:e.message,transactionSubmitted:false});}
    }
    if(body.action==='status') {
      try {
        const {assessment}=await getAssessment(circleId);
        let saved=executionStore.get(plan.id), transactionEvidence=[];
        if (saved.state === 'UNKNOWN' && Array.isArray(saved.attempts) && saved.attempts.length) {
          for (const attempt of saved.attempts) {
            if (saved.txHashes.includes(attempt.txHash)) continue;
            const evidence = await verifyTx({
              fetchImpl, rpcUrl, contractId: saved.contractId,
              txHash: attempt.txHash,
              method: attempt.action === 'start' ? 'start_public_distribution' : 'continue_public_distribution',
            });
            if (evidence.outcome === 'VERIFIED_FAILURE') {
              const { assessment: reconciledAssessment } = await getAssessment(circleId);
              if (reconciledAssessment.status !== 'RETRY_AVAILABLE'
                || reconciledAssessment.pending
                || reconciledAssessment.complete
                || reconciledAssessment.index !== attempt.recipientIndex
                || reconciledAssessment.plan.length !== saved.distributionPlan.length
                || reconciledAssessment.plan.some((entry, index) => entry.member !== saved.distributionPlan[index]?.member
                  || entry.amountYocto !== saved.distributionPlan[index]?.amountYocto)) {
                throw new Error('Finalized transaction failed, but fresh on-chain state does not prove the same recipient is safely retryable');
              }
              executionStore.recordAttemptOutcome(plan.id, evidence.txHash, 'VERIFIED_FAILURE');
              saved = executionStore.resolveVerifiedFailure(plan.id, evidence.txHash);
              break;
            }
            executionStore.recordAttemptOutcome(plan.id, evidence.txHash, 'VERIFIED_SUCCESS');
            saved = executionStore.recordSubmitted(plan.id, evidence.txHash);
          }
        }
        if(assessment.status==='COMPLETE'&&saved.state!=='FINALIZED'&&saved.txHashes.length===saved.distributionPlan.length) {
          for(let i=0;i<saved.txHashes.length;i++) {
            transactionEvidence.push(await verifyTx({
              fetchImpl,
              rpcUrl,
              contractId: saved.contractId,
              txHash: saved.txHashes[i],
              method: i === 0 ? 'start_public_distribution' : 'continue_public_distribution',
            }));
          }
          if (transactionEvidence.some(item => item.outcome !== 'VERIFIED_SUCCESS')) {
            throw new Error('Distribution cannot be finalized because every recipient transaction must have verified successful finality');
          }
          saved = executionStore.finalize(plan.id, {
            confirmed: true,
            evidence: transactionEvidence,
          });
        }
        return sendJson(res,200,{plan:saved,assessment,transactionEvidence,transactionSubmitted:false,note:saved.state==='FINALIZED'?'Every recipient transfer and the completed on-chain distribution were independently verified.':'Read-only status check; no transaction submitted.'});
      } catch(e){return sendJson(res,503,{error:'DISTRIBUTION_STATUS_UNAVAILABLE',message:e.message,transactionSubmitted:false});}
    }
    if(plan.state==='UNKNOWN') return sendJson(res,409,{error:'DISTRIBUTION_OUTCOME_UNKNOWN',message:'A previous submission outcome is uncertain. Do not retry; reconcile transaction and on-chain index first.'});
    if(body.action==='start'&&plan.state!=='AUTHORIZED') return sendJson(res,409,{error:'DISTRIBUTION_PLAN_NOT_AUTHORIZED',message:'Only a second-operator-authorized plan can start distribution.'});
    if(body.action==='continue'&&plan.state!=='SUBMITTED') return sendJson(res,409,{error:'DISTRIBUTION_PLAN_NOT_SUBMITTED',message:'Start distribution first and reconcile the finalized transfer before continuing.'});
    const actionLabel=body.action==='start'?'START':'CONTINUE';
    const expected=`${actionLabel} TESTNET DISTRIBUTION ${plan.contractId} ROUND ${plan.round} TOTAL ${plan.totalYocto} YOCTO`;
    if(body.confirmation!==expected) return sendJson(res,409,{error:'DISTRIBUTION_CONFIRMATION_MISMATCH',message:'Exact confirmation phrase does not match this testnet plan. No transaction submitted.'});
    if(inFlight.has(plan.id)) return sendJson(res,409,{error:'DISTRIBUTION_SUBMISSION_IN_PROGRESS',message:'A submission for this plan is in progress. Do not retry.'});
    inFlight.add(plan.id); let invoked=false;
    try {
      const {assessment,live}=await getAssessment(circleId);
      const expectedStatus=body.action==='start'?'READY_TO_START':'RETRY_AVAILABLE';
      if(live.currentRound!==plan.round||assessment.status!==expectedStatus||assessment.index!==plan.txHashes.length||assessment.pending||assessment.complete) return sendJson(res,409,{error:'DISTRIBUTION_LIFECYCLE_MISMATCH',assessment,message:'Fresh on-chain distribution state does not match the authorized next transfer. No transaction submitted.'});
      if(body.action==='start'&&assessment.plan.length!==0) return sendJson(res,409,{error:'DISTRIBUTION_ALREADY_STARTED',assessment,message:'On-chain distribution has already started. Do not submit start again.'});
      if(body.action==='continue'&&assessment.plan.length!==plan.distributionPlan.length) return sendJson(res,409,{error:'DISTRIBUTION_PLAN_MISMATCH',assessment,message:'On-chain distribution plan differs from the authorized local plan.'});
      let submission;
      try { submission=await submitDistribution({network:'testnet',contractId:plan.contractId,method:body.action==='start'?'start_public_distribution':'continue_public_distribution'}); }
      catch(e){ if(e?.submissionOutcomeUnknown===true){const unknown=executionStore.recordUnknown(plan.id,'CLI was invoked but no definitive transaction evidence was returned; reconcile before any retry.'); return sendJson(res,202,{plan:unknown,status:'UNKNOWN',transactionSubmitted:'UNKNOWN',message:'Submission outcome uncertain. Do not retry.'});} return sendJson(res,503,{error:'DISTRIBUTION_SIGNER_PREFLIGHT_FAILED',message:e.message||'Treasury signer preflight failed. No transaction was submitted.',transactionSubmitted:false}); }
      const method=body.action==='start'?'start_public_distribution':'continue_public_distribution';
      try {
        if (!submission || !TX.test(submission.txHash ?? '')) throw new Error('Signer returned no valid transaction hash; submission outcome must be reconciled before retry.');
        executionStore.recordAttempt(plan.id, {
          txHash: submission.txHash,
          action: body.action,
          round: plan.round,
          recipientIndex: assessment.index,
          recipient: plan.distributionPlan[assessment.index]?.member ?? 'unknown-recipient',
          recordedAt: new Date(clock()).toISOString(),
        });
      } catch(e) {
        const unknown=executionStore.recordUnknown(plan.id,'A transaction may have been submitted, but its hash could not be durably recorded; do not retry until reconciled.');
        return sendJson(res,202,{plan:unknown,status:'UNKNOWN',transactionSubmitted:'UNKNOWN',message:e.message});
      }
      let evidence;
      try { evidence=await verifyTx({fetchImpl,rpcUrl,contractId:plan.contractId,txHash:submission.txHash,method}); }
      catch(e){ const unknown=executionStore.recordUnknown(plan.id,'A transaction hash was durably recorded, but finalized RPC verification failed; reconcile before any retry.'); return sendJson(res,202,{plan:unknown,status:'UNKNOWN',transactionSubmitted:'UNKNOWN',txHash:submission.txHash,message:e.message}); }
      if (evidence.outcome !== 'VERIFIED_SUCCESS') {
        executionStore.recordAttemptOutcome(plan.id, evidence.txHash, 'VERIFIED_FAILURE');
        const unknown = executionStore.recordUnknown(plan.id, 'Finalized transaction evidence confirms failure; reconcile fresh on-chain recipient index before retrying.');
        return sendJson(res, 202, { plan: unknown, status: 'UNKNOWN', transactionEvidence: evidence, transactionSubmitted: 'UNKNOWN', message: 'Transaction finalized unsuccessfully. Reconcile status before any retry.' });
      }
      executionStore.recordAttemptOutcome(plan.id, evidence.txHash, 'VERIFIED_SUCCESS');
      const saved=executionStore.recordSubmitted(plan.id,evidence.txHash);
      return sendJson(res,200,{plan:saved,transactionEvidence:evidence,signerPublicKey:submission.signerPublicKey,transactionSubmitted:true,note:'One distribution call was submitted and independently verified against finalized NEAR testnet RPC. Check status before the next transfer.'});
    } catch(e){return sendJson(res,503,{error:'DISTRIBUTION_EXECUTION_BLOCKED',message:e.message,transactionSubmitted:false});}
    finally{inFlight.delete(plan.id);}
  };
}
