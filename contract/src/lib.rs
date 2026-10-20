use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::BorshStorageKey;
use near_sdk::{
    env, ext_contract, near_bindgen, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseResult,
};

mod reputation;

const CALLBACK_GAS: Gas = Gas::from_tgas(5);

#[derive(
    BorshDeserialize, BorshSerialize, Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize,
)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub enum CircleMode {
    Private,
    ProtectedPublic,
}

#[derive(BorshSerialize, BorshDeserialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Contributions,
    Guarantees,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct Guarantee {
    pub guarantor: AccountId,
    pub required_amount: u128,
    pub locked_amount: u128,
    pub accepted: bool,
    pub active: bool,
    pub expiry: u64,
    pub last_claimed_round: Option<u32>,
}

#[ext_contract(ext_self)]
trait ExtCircle {
    fn on_payout_complete(&mut self);
    fn on_guarantee_release_complete(&mut self, member: AccountId, amount: U128);
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
    guarantees: LookupMap<AccountId, Guarantee>,
    treasurer_agent: AccountId,
    mode: CircleMode,
    protection_balance: u128,
    pending_protection_used: u128,
    payout_pending: bool,
    payout_complete: bool,
    circle_completed: bool,
    pending_guarantee_release: Option<AccountId>,
    pending_release_amount: u128,
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
        mode: CircleMode,
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
            guarantees: LookupMap::new(StorageKey::Guarantees),
            treasurer_agent,
            mode,
            protection_balance: 0,
            pending_protection_used: 0,
            payout_pending: false,
            payout_complete: false,
            circle_completed: false,
            pending_guarantee_release: None,
            pending_release_amount: 0,
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

    /// A member proposes a full-pot guarantee. The guarantor must accept and fund it separately.
    pub fn request_guarantee(&mut self, guarantor: AccountId, required_amount: U128, expiry: u64) {
        assert!(!self.circle_completed, "Circle is already completed");
        assert_eq!(
            self.mode,
            CircleMode::ProtectedPublic,
            "Guarantors are only available for protected public circles"
        );
        let member = env::predecessor_account_id();
        assert!(
            self.members.contains(&member),
            "Caller is not a circle member"
        );
        assert_ne!(guarantor, member, "A member cannot guarantee themselves");
        assert!(
            self.guarantees.get(&member).is_none(),
            "A guarantee already exists for this member"
        );
        let total_pot = self
            .contribution_amount
            .checked_mul(self.members.len() as u128)
            .expect("Pot amount overflow");
        assert_eq!(
            required_amount.0, total_pot,
            "Guarantee must cover the full scheduled pot"
        );
        assert!(
            expiry > self.round_deadline,
            "Guarantee expiry must be after the current contribution deadline"
        );
        assert!(
            expiry > env::block_timestamp(),
            "Guarantee expiry must be in the future"
        );
        self.guarantees.insert(
            &member,
            &Guarantee {
                guarantor,
                required_amount: required_amount.0,
                locked_amount: 0,
                accepted: false,
                active: false,
                expiry,
                last_claimed_round: None,
            },
        );
    }

    /// Only the nominated guarantor may accept the exact stored terms.
    pub fn accept_guarantee(&mut self, member: AccountId) {
        assert!(!self.circle_completed, "Circle is already completed");
        let mut guarantee = self
            .guarantees
            .get(&member)
            .expect("No guarantee request exists");
        assert_eq!(
            env::predecessor_account_id(),
            guarantee.guarantor,
            "Only the nominated guarantor may accept"
        );
        assert!(
            !guarantee.accepted && !guarantee.active,
            "Guarantee is already accepted or active"
        );
        assert!(
            env::block_timestamp() < guarantee.expiry,
            "Guarantee request has expired"
        );
        guarantee.accepted = true;
        self.guarantees.insert(&member, &guarantee);
    }

    /// The nominated guarantor locks the full agreed amount in contract custody.
    #[payable]
    pub fn fund_guarantee(&mut self, member: AccountId) {
        assert!(!self.circle_completed, "Circle is already completed");
        let mut guarantee = self
            .guarantees
            .get(&member)
            .expect("No guarantee request exists");
        assert_eq!(
            env::predecessor_account_id(),
            guarantee.guarantor,
            "Only the nominated guarantor may fund this guarantee"
        );
        assert!(guarantee.accepted, "Guarantor must accept before funding");
        assert!(!guarantee.active, "Guarantee is already active");
        assert!(
            env::block_timestamp() < guarantee.expiry,
            "Guarantee request has expired"
        );
        let deposit = env::attached_deposit().as_yoctonear();
        assert_eq!(
            deposit, guarantee.required_amount,
            "Deposit must equal the full guarantee amount"
        );
        guarantee.locked_amount = deposit;
        guarantee.active = true;
        self.guarantees.insert(&member, &guarantee);
    }

    /// Moves one missed contribution from locked collateral into the protection reserve.
    /// This is permissionless but only possible after the deadline and for an objective shortfall.
    pub fn claim_guarantee_for_missed_contribution(&mut self, member: AccountId) {
        assert!(!self.circle_completed, "Circle is already completed");
        assert_eq!(
            self.mode,
            CircleMode::ProtectedPublic,
            "Guarantee claims are only available for protected public circles"
        );
        assert!(
            self.members.contains(&member),
            "Account is not a circle member"
        );
        assert!(
            env::block_timestamp() >= self.round_deadline,
            "Guarantee claim is only allowed after the contribution deadline"
        );
        assert!(
            self.contributions.get(&member).is_none(),
            "Member has contributed this round"
        );

        let mut guarantee = self
            .guarantees
            .get(&member)
            .expect("No guarantee exists for this member");
        assert!(guarantee.active, "Guarantee is not active");
        assert!(
            env::block_timestamp() < guarantee.expiry,
            "Guarantee has expired"
        );
        assert_ne!(
            guarantee.last_claimed_round,
            Some(self.current_round),
            "Guarantee already claimed for this round"
        );
        assert!(
            guarantee.locked_amount >= self.contribution_amount,
            "Remaining guarantee collateral cannot cover one contribution"
        );

        guarantee.locked_amount -= self.contribution_amount;
        guarantee.last_claimed_round = Some(self.current_round);
        self.protection_balance = self
            .protection_balance
            .checked_add(self.contribution_amount)
            .expect("Protection balance overflow while claiming guarantee");
        self.guarantees.insert(&member, &guarantee);
    }

    pub fn get_guarantee(&self, member: AccountId) -> Option<Guarantee> {
        self.guarantees.get(&member)
    }

    /// Returns unused guarantor collateral only after every scheduled payout succeeds.
    pub fn release_guarantee(&mut self, member: AccountId) -> Promise {
        assert!(
            self.circle_completed,
            "Circle must be completed before collateral release"
        );
        assert!(!self.payout_pending, "A payout is still pending");
        assert!(
            self.pending_guarantee_release.is_none(),
            "A collateral release is already pending"
        );

        let mut guarantee = self
            .guarantees
            .get(&member)
            .expect("No guarantee exists for this member");
        assert!(guarantee.active, "Guarantee is not active");
        let amount = guarantee.locked_amount;
        assert!(amount > 0, "No collateral remains to release");

        guarantee.locked_amount = 0;
        guarantee.active = false;
        self.guarantees.insert(&member, &guarantee);
        self.pending_guarantee_release = Some(member.clone());
        self.pending_release_amount = amount;

        Promise::new(guarantee.guarantor)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_guarantee_release_complete(member, U128(amount)),
            )
    }

    #[private]
    pub fn on_guarantee_release_complete(&mut self, member: AccountId, amount: U128) {
        assert_eq!(
            self.pending_guarantee_release.as_ref(),
            Some(&member),
            "No matching collateral release is pending"
        );
        assert_eq!(
            self.pending_release_amount, amount.0,
            "Collateral release amount does not match pending amount"
        );

        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                self.pending_guarantee_release = None;
                self.pending_release_amount = 0;
            }
            _ => {
                let mut guarantee = self
                    .guarantees
                    .get(&member)
                    .expect("Guarantee disappeared during collateral release");
                assert!(
                    !guarantee.active && guarantee.locked_amount == 0,
                    "Guarantee state changed while collateral release was pending"
                );
                guarantee.locked_amount = amount.0;
                guarantee.active = true;
                self.guarantees.insert(&member, &guarantee);
                self.pending_guarantee_release = None;
                self.pending_release_amount = 0;
            }
        }
    }

    pub fn is_circle_completed(&self) -> bool {
        self.circle_completed
    }

    /// Adds separately accounted protection funds, never counted as contributions.
    #[payable]
    pub fn fund_protection(&mut self) {
        assert!(!self.circle_completed, "Circle is already completed");
        assert_eq!(
            self.mode,
            CircleMode::ProtectedPublic,
            "Protection funding is only available for protected public circles"
        );
        let deposit = env::attached_deposit().as_yoctonear();
        assert!(deposit > 0, "Protection deposit must be positive");
        self.protection_balance = self
            .protection_balance
            .checked_add(deposit)
            .expect("Protection balance overflow");
    }

    pub fn release_payout(&mut self) -> Promise {
        self.assert_treasurer();
        assert!(!self.circle_completed, "Circle is already completed");
        assert!(
            !self.payout_pending && !self.payout_complete,
            "Payout is already pending or complete"
        );
        let contributed_count = self.contribution_count_internal();
        let missing_count = self.members.len() - contributed_count;
        if self.mode == CircleMode::Private {
            assert_eq!(
                missing_count, 0,
                "Every member must contribute before payout in Stage 1"
            );
            self.pending_protection_used = 0;
        } else if missing_count > 0 {
            assert!(
                env::block_timestamp() >= self.round_deadline,
                "Protected shortfall can only be covered after the contribution deadline"
            );
            let shortfall = self
                .contribution_amount
                .checked_mul(missing_count as u128)
                .expect("Shortfall amount overflow");
            assert!(
                self.protection_balance >= shortfall,
                "Protection reserve is insufficient for the contribution shortfall"
            );
            self.protection_balance -= shortfall;
            self.pending_protection_used = shortfall;
        } else {
            self.pending_protection_used = 0;
        }

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
                self.pending_protection_used = 0;
                if (self.current_round as usize) + 1 >= self.payout_order.len() {
                    self.circle_completed = true;
                }
            }
            _ => {
                self.protection_balance = self
                    .protection_balance
                    .checked_add(self.pending_protection_used)
                    .expect("Protection balance overflow while restoring failed payout");
                self.pending_protection_used = 0;
                self.payout_pending = false;
                self.payout_complete = false;
            }
        }
    }

    pub fn advance_round(&mut self, new_deadline: u64) {
        self.assert_treasurer();
        assert!(!self.circle_completed, "Circle is already completed");
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
    pub fn get_mode(&self) -> CircleMode {
        self.mode
    }

    pub fn get_protection_balance(&self) -> U128 {
        U128(self.protection_balance)
    }

    /// Current reserve needed to cover every contribution still missing this round.
    pub fn get_required_protection(&self) -> U128 {
        if self.mode == CircleMode::ProtectedPublic && !self.payout_pending && !self.payout_complete
        {
            U128(
                self.contribution_amount
                    .checked_mul((self.members.len() - self.contribution_count_internal()) as u128)
                    .expect("Shortfall amount overflow"),
            )
        } else {
            U128(0)
        }
    }

    pub fn get_pending_protection_used(&self) -> U128 {
        U128(self.pending_protection_used)
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
    use near_sdk::test_utils::{testing_env_with_promise_results, VMContextBuilder};
    use near_sdk::testing_env;

    const CONTRIBUTION: u128 = 50;
    const NOW: u64 = 1_000_000_000;

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn context(caller: &str, deposit: u128) {
        context_at(caller, deposit, NOW);
    }

    fn context_at(caller: &str, deposit: u128, timestamp: u64) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(account("circle.near"))
            .predecessor_account_id(account(caller))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(timestamp);
        testing_env!(builder.build());
    }

    fn sample_circle(mode: CircleMode) -> Circle {
        context("treasurer.near", 0);
        Circle::new(
            vec![account("alice.near"), account("bob.near")],
            U128(CONTRIBUTION),
            vec![account("alice.near"), account("bob.near")],
            NOW + 1_000_000_000,
            account("treasurer.near"),
            mode,
        )
    }

    #[test]
    fn guarantor_must_accept_and_lock_the_full_pot() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("alice.near", 0);
        circle.request_guarantee(
            account("guarantor.near"),
            U128(2 * CONTRIBUTION),
            NOW + 2_000_000_000,
        );
        let requested = circle.get_guarantee(account("alice.near")).unwrap();
        assert!(!requested.accepted);
        assert!(!requested.active);
        assert_eq!(requested.locked_amount, 0);

        context("guarantor.near", 0);
        circle.accept_guarantee(account("alice.near"));
        assert!(
            circle
                .get_guarantee(account("alice.near"))
                .unwrap()
                .accepted
        );

        context("guarantor.near", 2 * CONTRIBUTION);
        circle.fund_guarantee(account("alice.near"));
        let active = circle.get_guarantee(account("alice.near")).unwrap();
        assert!(active.accepted);
        assert!(active.active);
        assert_eq!(active.locked_amount, 2 * CONTRIBUTION);
        assert_eq!(active.required_amount, 2 * CONTRIBUTION);
    }

    #[test]
    #[should_panic(expected = "Deposit must equal the full guarantee amount")]
    fn guarantor_cannot_activate_with_underfunded_deposit() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("alice.near", 0);
        circle.request_guarantee(
            account("guarantor.near"),
            U128(2 * CONTRIBUTION),
            NOW + 2_000_000_000,
        );
        context("guarantor.near", 0);
        circle.accept_guarantee(account("alice.near"));
        context("guarantor.near", CONTRIBUTION);
        circle.fund_guarantee(account("alice.near"));
    }

    #[test]
    #[should_panic(expected = "Only the nominated guarantor may accept")]
    fn only_nominated_guarantor_can_accept() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("alice.near", 0);
        circle.request_guarantee(
            account("guarantor.near"),
            U128(2 * CONTRIBUTION),
            NOW + 2_000_000_000,
        );
        context("bob.near", 0);
        circle.accept_guarantee(account("alice.near"));
    }

    #[test]
    fn guarantee_claim_moves_one_missed_contribution_into_reserve() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("alice.near", 0);
        circle.request_guarantee(
            account("guarantor.near"),
            U128(2 * CONTRIBUTION),
            NOW + 2_000_000_000,
        );
        context("guarantor.near", 0);
        circle.accept_guarantee(account("alice.near"));
        context("guarantor.near", 2 * CONTRIBUTION);
        circle.fund_guarantee(account("alice.near"));

        context("bob.near", CONTRIBUTION);
        circle.contribute();
        context_at("anyone.near", 0, NOW + 1_000_000_000);
        circle.claim_guarantee_for_missed_contribution(account("alice.near"));

        let guarantee = circle.get_guarantee(account("alice.near")).unwrap();
        assert_eq!(guarantee.locked_amount, CONTRIBUTION);
        assert_eq!(guarantee.last_claimed_round, Some(0));
        assert_eq!(circle.get_protection_balance(), U128(CONTRIBUTION));

        context_at("treasurer.near", 0, NOW + 1_000_000_000);
        let _ = circle.release_payout();
        assert!(circle.is_payout_pending());
        assert_eq!(circle.get_pending_protection_used(), U128(CONTRIBUTION));
    }

    #[test]
    #[should_panic(expected = "Guarantee claim is only allowed after the contribution deadline")]
    fn guarantee_claim_is_rejected_before_deadline() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("alice.near", 0);
        circle.request_guarantee(
            account("guarantor.near"),
            U128(2 * CONTRIBUTION),
            NOW + 2_000_000_000,
        );
        context("guarantor.near", 0);
        circle.accept_guarantee(account("alice.near"));
        context("guarantor.near", 2 * CONTRIBUTION);
        circle.fund_guarantee(account("alice.near"));
        context("anyone.near", 0);
        circle.claim_guarantee_for_missed_contribution(account("alice.near"));
    }

    #[test]
    #[should_panic(expected = "Guarantee already claimed for this round")]
    fn guarantee_cannot_be_claimed_twice_in_one_round() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("alice.near", 0);
        circle.request_guarantee(
            account("guarantor.near"),
            U128(2 * CONTRIBUTION),
            NOW + 2_000_000_000,
        );
        context("guarantor.near", 0);
        circle.accept_guarantee(account("alice.near"));
        context("guarantor.near", 2 * CONTRIBUTION);
        circle.fund_guarantee(account("alice.near"));
        context_at("anyone.near", 0, NOW + 1_000_000_000);
        circle.claim_guarantee_for_missed_contribution(account("alice.near"));
        circle.claim_guarantee_for_missed_contribution(account("alice.near"));
    }

    #[test]
    fn accepts_exact_member_contribution_once() {
        let mut circle = sample_circle(CircleMode::Private);
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
        let mut circle = sample_circle(CircleMode::Private);
        context("alice.near", CONTRIBUTION - 1);
        circle.contribute();
    }

    #[test]
    #[should_panic(expected = "Caller is not a circle member")]
    fn rejects_non_member_contribution() {
        let mut circle = sample_circle(CircleMode::Private);
        context("outsider.near", CONTRIBUTION);
        circle.contribute();
    }

    #[test]
    #[should_panic(expected = "Member already contributed this round")]
    fn rejects_duplicate_contribution() {
        let mut circle = sample_circle(CircleMode::Private);
        context("alice.near", CONTRIBUTION);
        circle.contribute();
        context("alice.near", CONTRIBUTION);
        circle.contribute();
    }

    fn contribute_all_members(circle: &mut Circle) {
        context("alice.near", CONTRIBUTION);
        circle.contribute();
        context("bob.near", CONTRIBUTION);
        circle.contribute();
    }

    fn complete_current_payout(circle: &mut Circle) {
        contribute_all_members(circle);
        context("treasurer.near", 0);
        let _ = circle.release_payout();
        let callback_context = VMContextBuilder::new()
            .current_account_id(account("circle.near"))
            .predecessor_account_id(account("circle.near"))
            .block_timestamp(NOW + 1_000_000_000)
            .build();
        testing_env_with_promise_results(callback_context, PromiseResult::Successful(Vec::new()));
        circle.on_payout_complete();
    }

    fn completed_circle_with_funded_guarantee() -> Circle {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("alice.near", 0);
        circle.request_guarantee(
            account("guarantor.near"),
            U128(2 * CONTRIBUTION),
            NOW + 3_000_000_000,
        );
        context("guarantor.near", 0);
        circle.accept_guarantee(account("alice.near"));
        context("guarantor.near", 2 * CONTRIBUTION);
        circle.fund_guarantee(account("alice.near"));

        complete_current_payout(&mut circle);
        assert!(!circle.is_circle_completed());
        context("treasurer.near", 0);
        circle.advance_round(NOW + 2_000_000_000);
        complete_current_payout(&mut circle);
        assert!(circle.is_circle_completed());
        circle
    }

    #[test]
    #[should_panic(expected = "Protection reserve is insufficient for the contribution shortfall")]
    fn protected_public_payout_pauses_when_reserve_cannot_cover_shortfall() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("alice.near", CONTRIBUTION);
        circle.contribute();
        context_at("treasurer.near", 0, NOW + 1_000_000_000);
        let _ = circle.release_payout();
    }

    #[test]
    fn protected_public_payout_requires_and_accepts_full_separate_protection() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("sponsor.near", CONTRIBUTION * 2);
        circle.fund_protection();
        assert_eq!(circle.get_protection_balance(), U128(CONTRIBUTION * 2));
        assert_eq!(circle.get_required_protection(), U128(CONTRIBUTION * 2));
        contribute_all_members(&mut circle);
        context("treasurer.near", 0);
        let _ = circle.release_payout();
        assert!(circle.is_payout_pending());
    }

    #[test]
    fn protected_public_payout_uses_only_the_actual_shortfall() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("sponsor.near", CONTRIBUTION);
        circle.fund_protection();
        context("alice.near", CONTRIBUTION);
        circle.contribute();
        assert_eq!(circle.get_required_protection(), U128(CONTRIBUTION));
        context_at("treasurer.near", 0, NOW + 1_000_000_000);
        let _ = circle.release_payout();
        assert!(circle.is_payout_pending());
        assert_eq!(circle.get_required_protection(), U128(0));
        assert_eq!(circle.get_protection_balance(), U128(0));
        assert_eq!(circle.get_pending_protection_used(), U128(CONTRIBUTION));
    }

    #[test]
    #[should_panic(
        expected = "Protected shortfall can only be covered after the contribution deadline"
    )]
    fn protected_public_shortfall_cannot_be_covered_before_deadline() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("sponsor.near", CONTRIBUTION);
        circle.fund_protection();
        context("alice.near", CONTRIBUTION);
        circle.contribute();
        context("treasurer.near", 0);
        let _ = circle.release_payout();
    }

    #[test]
    fn failed_protected_payout_restores_reserved_shortfall() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("sponsor.near", CONTRIBUTION);
        circle.fund_protection();
        context("alice.near", CONTRIBUTION);
        circle.contribute();
        context_at("treasurer.near", 0, NOW + 1_000_000_000);
        let _ = circle.release_payout();
        assert_eq!(circle.get_protection_balance(), U128(0));

        let callback_context = VMContextBuilder::new()
            .current_account_id(account("circle.near"))
            .predecessor_account_id(account("circle.near"))
            .block_timestamp(NOW + 1_000_000_000)
            .build();
        testing_env_with_promise_results(callback_context, PromiseResult::Failed);
        circle.on_payout_complete();
        assert!(!circle.is_payout_pending());
        assert!(!circle.is_payout_complete());
        assert_eq!(circle.get_protection_balance(), U128(CONTRIBUTION));
        assert_eq!(circle.get_pending_protection_used(), U128(0));
    }

    #[test]
    fn successful_protected_payout_keeps_reserve_shortfall_spent() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("sponsor.near", CONTRIBUTION);
        circle.fund_protection();
        context("alice.near", CONTRIBUTION);
        circle.contribute();
        context_at("treasurer.near", 0, NOW + 1_000_000_000);
        let _ = circle.release_payout();

        let callback_context = VMContextBuilder::new()
            .current_account_id(account("circle.near"))
            .predecessor_account_id(account("circle.near"))
            .block_timestamp(NOW + 1_000_000_000)
            .build();
        testing_env_with_promise_results(callback_context, PromiseResult::Successful(Vec::new()));
        circle.on_payout_complete();
        assert!(!circle.is_payout_pending());
        assert!(circle.is_payout_complete());
        assert_eq!(circle.get_protection_balance(), U128(0));
        assert_eq!(circle.get_pending_protection_used(), U128(0));
        assert_eq!(circle.get_required_protection(), U128(0));
    }

    #[test]
    #[should_panic(expected = "Circle must be completed before collateral release")]
    fn collateral_cannot_be_released_before_final_payout() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("anyone.near", 0);
        let _ = circle.release_guarantee(account("alice.near"));
    }

    #[test]
    fn final_successful_payout_completes_circle_and_unused_collateral_can_be_released() {
        let mut circle = completed_circle_with_funded_guarantee();
        assert!(circle.is_circle_completed());
        assert_eq!(circle.get_round(), 1);

        context("anyone.near", 0);
        let _ = circle.release_guarantee(account("alice.near"));
        let pending = circle.get_guarantee(account("alice.near")).unwrap();
        assert!(!pending.active);
        assert_eq!(pending.locked_amount, 0);

        let callback_context = VMContextBuilder::new()
            .current_account_id(account("circle.near"))
            .predecessor_account_id(account("circle.near"))
            .block_timestamp(NOW + 2_000_000_000)
            .build();
        testing_env_with_promise_results(callback_context, PromiseResult::Successful(Vec::new()));
        circle.on_guarantee_release_complete(account("alice.near"), U128(2 * CONTRIBUTION));

        let released = circle.get_guarantee(account("alice.near")).unwrap();
        assert!(!released.active);
        assert_eq!(released.locked_amount, 0);
    }

    #[test]
    #[should_panic(expected = "A collateral release is already pending")]
    fn only_one_collateral_release_can_be_pending() {
        let mut circle = completed_circle_with_funded_guarantee();
        context("anyone.near", 0);
        let _ = circle.release_guarantee(account("alice.near"));
        let _ = circle.release_guarantee(account("alice.near"));
    }

    #[test]
    fn failed_collateral_release_restores_locked_amount_and_active_guarantee() {
        let mut circle = completed_circle_with_funded_guarantee();
        context("anyone.near", 0);
        let _ = circle.release_guarantee(account("alice.near"));

        let callback_context = VMContextBuilder::new()
            .current_account_id(account("circle.near"))
            .predecessor_account_id(account("circle.near"))
            .block_timestamp(NOW + 2_000_000_000)
            .build();
        testing_env_with_promise_results(callback_context, PromiseResult::Failed);
        circle.on_guarantee_release_complete(account("alice.near"), U128(2 * CONTRIBUTION));

        let restored = circle.get_guarantee(account("alice.near")).unwrap();
        assert!(restored.active);
        assert_eq!(restored.locked_amount, 2 * CONTRIBUTION);
    }

    #[test]
    #[should_panic(expected = "Circle is already completed")]
    fn cannot_advance_after_final_payout() {
        let mut circle = completed_circle_with_funded_guarantee();
        context("treasurer.near", 0);
        circle.advance_round(NOW + 4_000_000_000);
    }

    #[test]
    fn private_circle_can_pay_without_protection() {
        let mut circle = sample_circle(CircleMode::Private);
        contribute_all_members(&mut circle);
        context("treasurer.near", 0);
        let _ = circle.release_payout();
        assert!(circle.is_payout_pending());
        assert_eq!(circle.get_required_protection(), U128(0));
    }

    #[test]
    #[should_panic(expected = "Protection funding is only available for protected public circles")]
    fn private_circle_cannot_accept_protection_deposit() {
        let mut circle = sample_circle(CircleMode::Private);
        context("sponsor.near", CONTRIBUTION);
        circle.fund_protection();
    }

    #[test]
    #[should_panic(expected = "Protection deposit must be positive")]
    fn rejects_zero_protection_deposit() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("sponsor.near", 0);
        circle.fund_protection();
    }
    #[test]
    #[should_panic(expected = "Only the treasurer agent may call this method")]
    fn rejects_unauthorized_payout() {
        let mut circle = sample_circle(CircleMode::Private);
        context("outsider.near", 0);
        let _ = circle.release_payout();
    }
}
