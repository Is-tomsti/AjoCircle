use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::U128;
use near_sdk::BorshStorageKey;
use near_sdk::{
    env, ext_contract, near_bindgen, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseResult,
};

mod reputation;

const CALLBACK_GAS: Gas = Gas::from_tgas(5);

#[derive(BorshSerialize, BorshDeserialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Contributions,
}

#[ext_contract(ext_self)]
trait ExtCircle {
    fn on_payout_complete(&mut self);
}

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Circle {
    members: Vec<AccountId>,
    contribution_amount: u128,
    payout_order: Vec<AccountId>,
    current_round: u32,
    round_deadline: u64,
    contributions: LookupMap<AccountId, u128>,
    treasurer_agent: AccountId,
    payout_pending: bool,
    payout_complete: bool,
}

#[near_bindgen]
impl Circle {
    #[init]
    pub fn new(
        members: Vec<AccountId>,
        contribution_amount: U128,
        payout_order: Vec<AccountId>,
        round_deadline: u64,
        treasurer_agent: AccountId,
    ) -> Self {
        assert!(!members.is_empty(), "Circle must have at least one member");
        assert!(
            contribution_amount.0 > 0,
            "Contribution amount must be positive"
        );
        assert_eq!(
            members.len(),
            payout_order.len(),
            "Payout order must include every member"
        );
        assert!(
            round_deadline > env::block_timestamp(),
            "Round deadline must be in the future"
        );

        for (index, member) in members.iter().enumerate() {
            assert!(!members[..index].contains(member), "Duplicate member");
        }
        for (index, recipient) in payout_order.iter().enumerate() {
            assert!(
                members.contains(recipient),
                "Payout recipient must be a member"
            );
            assert!(
                !payout_order[..index].contains(recipient),
                "Duplicate payout recipient"
            );
        }

        Self {
            members,
            contribution_amount: contribution_amount.0,
            payout_order,
            current_round: 0,
            round_deadline,
            contributions: LookupMap::new(StorageKey::Contributions),
            treasurer_agent,
            payout_pending: false,
            payout_complete: false,
        }
    }

    #[payable]
    pub fn contribute(&mut self) {
        assert!(
            !self.payout_pending && !self.payout_complete,
            "Round is not accepting contributions"
        );
        assert!(
            env::block_timestamp() < self.round_deadline,
            "Contribution deadline has passed"
        );
        let member = env::predecessor_account_id();
        assert!(
            self.members.contains(&member),
            "Caller is not a circle member"
        );
        assert!(
            self.contributions.get(&member).is_none(),
            "Member already contributed this round"
        );
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            self.contribution_amount,
            "Attached deposit must equal the contribution amount"
        );
        self.contributions
            .insert(&member, &self.contribution_amount);
    }

    pub fn release_payout(&mut self) -> Promise {
        self.assert_treasurer();
        assert!(
            !self.payout_pending && !self.payout_complete,
            "Payout is already pending or complete"
        );
        assert_eq!(
            self.contribution_count_internal(),
            self.members.len(),
            "Every member must contribute before payout in Stage 1"
        );

        let recipient =
            self.payout_order[(self.current_round as usize) % self.payout_order.len()].clone();
        let pot = self
            .contribution_amount
            .checked_mul(self.members.len() as u128)
            .expect("Pot amount overflow");
        self.payout_pending = true;

        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(pot))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_payout_complete(),
            )
    }

    #[private]
    pub fn on_payout_complete(&mut self) {
        assert!(self.payout_pending, "No payout is pending");
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                self.payout_pending = false;
                self.payout_complete = true;
            }
            _ => {
                self.payout_pending = false;
                self.payout_complete = false;
            }
        }
    }

    pub fn advance_round(&mut self, new_deadline: u64) {
        self.assert_treasurer();
        assert!(
            self.payout_complete,
            "Payout must succeed before advancing the round"
        );
        assert!(
            new_deadline > env::block_timestamp(),
            "Next deadline must be in the future"
        );
        for member in &self.members {
            self.contributions.remove(member);
        }
        self.current_round = self
            .current_round
            .checked_add(1)
            .expect("Round counter overflow");
        self.round_deadline = new_deadline;
        self.payout_complete = false;
    }

    pub fn get_round(&self) -> u32 {
        self.current_round
    }
    pub fn get_round_deadline(&self) -> u64 {
        self.round_deadline
    }
    pub fn get_contribution_count(&self) -> u32 {
        self.contribution_count_internal() as u32
    }
    pub fn get_contribution(&self, member: AccountId) -> Option<U128> {
        self.contributions.get(&member).map(U128)
    }
    pub fn get_current_recipient(&self) -> AccountId {
        self.payout_order[(self.current_round as usize) % self.payout_order.len()].clone()
    }
    pub fn is_payout_pending(&self) -> bool {
        self.payout_pending
    }
    pub fn is_payout_complete(&self) -> bool {
        self.payout_complete
    }

    fn contribution_count_internal(&self) -> usize {
        self.members
            .iter()
            .filter(|member| self.contributions.get(member).is_some())
            .count()
    }

    fn assert_treasurer(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.treasurer_agent,
            "Only the treasurer agent may call this method"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const CONTRIBUTION: u128 = 50;
    const NOW: u64 = 1_000_000_000;

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn context(caller: &str, deposit: u128) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(account("circle.near"))
            .predecessor_account_id(account(caller))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(NOW);
        testing_env!(builder.build());
    }

    fn sample_circle() -> Circle {
        context("treasurer.near", 0);
        Circle::new(
            vec![account("alice.near"), account("bob.near")],
            U128(CONTRIBUTION),
            vec![account("alice.near"), account("bob.near")],
            NOW + 1_000_000_000,
            account("treasurer.near"),
        )
    }

    #[test]
    fn accepts_exact_member_contribution_once() {
        let mut circle = sample_circle();
        context("alice.near", CONTRIBUTION);
        circle.contribute();
        assert_eq!(circle.get_contribution_count(), 1);
        assert_eq!(
            circle.get_contribution(account("alice.near")),
            Some(U128(CONTRIBUTION))
        );
    }

    #[test]
    #[should_panic(expected = "Attached deposit must equal the contribution amount")]
    fn rejects_wrong_contribution_amount() {
        let mut circle = sample_circle();
        context("alice.near", CONTRIBUTION - 1);
        circle.contribute();
    }

    #[test]
    #[should_panic(expected = "Caller is not a circle member")]
    fn rejects_non_member_contribution() {
        let mut circle = sample_circle();
        context("outsider.near", CONTRIBUTION);
        circle.contribute();
    }

    #[test]
    #[should_panic(expected = "Member already contributed this round")]
    fn rejects_duplicate_contribution() {
        let mut circle = sample_circle();
        context("alice.near", CONTRIBUTION);
        circle.contribute();
        context("alice.near", CONTRIBUTION);
        circle.contribute();
    }

    #[test]
    #[should_panic(expected = "Only the treasurer agent may call this method")]
    fn rejects_unauthorized_payout() {
        let mut circle = sample_circle();
        context("outsider.near", 0);
        let _ = circle.release_payout();
    }
}
