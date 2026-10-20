use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementRequest {
    pub intent_id: String,
    pub reference: String,
    pub nonce: String,
    pub source_chain: String,
    pub source_tx: String,
    pub destination_chain: String,
    pub destination_account: String,
    pub asset_id: String,
    pub amount: u128,
    pub circle_id: String,
    pub member_id: String,
    pub round: u32,
}

impl SettlementRequest {
    fn expected_reference(&self) -> String {
        format!(
            "ajo:{}:{}:{}:{}:{}",
            self.circle_id, self.member_id, self.round, self.amount, self.nonce
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementStatus {
    Pending,
    Settled,
    Failed,
    Refunded,
    Incomplete,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementObservation {
    pub source_chain: String,
    pub source_tx: String,
    pub reference: String,
    pub destination_chain: String,
    pub destination_account: String,
    pub asset_id: String,
    pub amount: u128,
    pub confirmations: u64,
    pub status: SettlementStatus,
}

pub trait SettlementSource {
    /// Must query an authoritative chain/settlement source, not caller-supplied JSON.
    fn lookup(&self, source_chain: &str, source_tx: &str) -> Result<SettlementObservation, String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedSettlement {
    pub intent_id: String,
    pub source_chain: String,
    pub source_tx: String,
    pub destination_chain: String,
    pub destination_account: String,
    pub asset_id: String,
    pub amount: u128,
    pub circle_id: String,
    pub member_id: String,
    pub round: u32,
}

#[derive(Default)]
pub struct SettlementAdapter {
    consumed_intents: HashSet<String>,
    consumed_transactions: HashSet<String>,
}

impl SettlementAdapter {
    pub fn verify<S: SettlementSource>(
        &mut self,
        source: &S,
        request: &SettlementRequest,
        minimum_confirmations: u64,
    ) -> Result<VerifiedSettlement, String> {
        if request.intent_id.trim().is_empty()
            || request.reference.trim().is_empty()
            || request.source_chain.trim().is_empty()
            || request.source_tx.trim().is_empty()
            || request.destination_chain.trim().is_empty()
            || request.destination_account.trim().is_empty()
            || request.asset_id.trim().is_empty()
            || request.circle_id.trim().is_empty()
            || request.member_id.trim().is_empty()
            || request.nonce.trim().is_empty()
            || request.amount == 0
            || request.reference != request.expected_reference()
        {
            return Err("Request has missing identifiers or a zero amount".into());
        }

        let tx_key = format!("{}:{}", request.source_chain, request.source_tx);
        if self.consumed_intents.contains(&request.intent_id)
            || self.consumed_transactions.contains(&tx_key)
        {
            return Err("Intent or source transaction has already been consumed".into());
        }

        let observed = source.lookup(&request.source_chain, &request.source_tx)?;
        if observed.status != SettlementStatus::Settled {
            return Err("Settlement is not in the settled state".into());
        }
        if observed.confirmations < minimum_confirmations {
            return Err("Settlement has insufficient confirmations".into());
        }
        if observed.source_chain != request.source_chain
            || observed.source_tx != request.source_tx
            || observed.reference != request.reference
            || observed.destination_chain != request.destination_chain
            || observed.destination_account != request.destination_account
            || observed.asset_id != request.asset_id
            || observed.amount != request.amount
        {
            return Err("Observed settlement does not match the requested payment".into());
        }

        // Consume only after every check succeeds. Production must persist this atomically.
        self.consumed_intents.insert(request.intent_id.clone());
        self.consumed_transactions.insert(tx_key);
        Ok(VerifiedSettlement {
            intent_id: request.intent_id.clone(),
            source_chain: request.source_chain.clone(),
            source_tx: request.source_tx.clone(),
            destination_chain: request.destination_chain.clone(),
            destination_account: request.destination_account.clone(),
            asset_id: request.asset_id.clone(),
            amount: request.amount,
            circle_id: request.circle_id.clone(),
            member_id: request.member_id.clone(),
            round: request.round,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockSource(Result<SettlementObservation, String>);

    impl SettlementSource for MockSource {
        fn lookup(&self, _chain: &str, _tx: &str) -> Result<SettlementObservation, String> {
            self.0.clone()
        }
    }

    fn request() -> SettlementRequest {
        SettlementRequest {
            intent_id: "intent-001".into(),
            reference: "ajo:circle-7:alice.near:2:25000000:nonce-abc".into(),
            nonce: "nonce-abc".into(),
            source_chain: "ethereum".into(),
            source_tx: "0xabc123".into(),
            destination_chain: "near".into(),
            destination_account: "alice.near".into(),
            asset_id: "nep141:usdc.example".into(),
            amount: 25_000_000,
            circle_id: "circle-7".into(),
            member_id: "alice.near".into(),
            round: 2,
        }
    }

    fn observation(req: &SettlementRequest) -> SettlementObservation {
        SettlementObservation {
            source_chain: req.source_chain.clone(),
            source_tx: req.source_tx.clone(),
            reference: req.reference.clone(),
            destination_chain: req.destination_chain.clone(),
            destination_account: req.destination_account.clone(),
            asset_id: req.asset_id.clone(),
            amount: req.amount,
            confirmations: 20,
            status: SettlementStatus::Settled,
        }
    }

    #[test]
    fn accepts_exact_finalized_settlement() {
        let req = request();
        let source = MockSource(Ok(observation(&req)));
        let mut adapter = SettlementAdapter::default();
        let verified = adapter.verify(&source, &req, 12).unwrap();
        assert_eq!(verified.circle_id, "circle-7");
        assert_eq!(verified.member_id, "alice.near");
        assert_eq!(verified.round, 2);
        assert_eq!(verified.amount, req.amount);
    }

    #[test]
    fn rejects_pending_settlement() {
        let req = request();
        let mut observed = observation(&req);
        observed.status = SettlementStatus::Pending;
        let source = MockSource(Ok(observed));
        assert!(SettlementAdapter::default()
            .verify(&source, &req, 12)
            .is_err());
    }

    #[test]
    fn rejects_wrong_recipient_or_amount() {
        let req = request();
        let mut observed = observation(&req);
        observed.destination_account = "attacker.near".into();
        let source = MockSource(Ok(observed));
        assert!(SettlementAdapter::default()
            .verify(&source, &req, 12)
            .is_err());
    }

    #[test]
    fn rejects_insufficient_confirmations() {
        let req = request();
        let mut observed = observation(&req);
        observed.confirmations = 3;
        let source = MockSource(Ok(observed));
        assert!(SettlementAdapter::default()
            .verify(&source, &req, 12)
            .is_err());
    }

    #[test]
    fn rejects_replay_of_intent_or_transaction() {
        let req = request();
        let source = MockSource(Ok(observation(&req)));
        let mut adapter = SettlementAdapter::default();
        adapter.verify(&source, &req, 12).unwrap();
        assert!(adapter.verify(&source, &req, 12).is_err());
        let mut another_intent = req.clone();
        another_intent.intent_id = "intent-002".into();
        assert!(adapter.verify(&source, &another_intent, 12).is_err());
    }

    #[test]
    fn rejects_request_tampering_that_changes_member_round_or_amount() {
        let mut req = request();
        req.member_id = "mallory.near".into();
        let source = MockSource(Ok(observation(&req)));
        assert!(SettlementAdapter::default()
            .verify(&source, &req, 12)
            .is_err());

        let mut req = request();
        req.amount += 1;
        let source = MockSource(Ok(observation(&req)));
        assert!(SettlementAdapter::default()
            .verify(&source, &req, 12)
            .is_err());
    }

    #[test]
    fn rejects_source_lookup_failure() {
        let req = request();
        let source = MockSource(Err("RPC unavailable".into()));
        assert!(SettlementAdapter::default()
            .verify(&source, &req, 12)
            .is_err());
    }
}
