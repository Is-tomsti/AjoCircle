use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
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
    ProtectionContributions,
    TotalContributions,
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
    fn on_public_distribution_transfer(&mut self);
    fn on_guarantee_release_complete(&mut self, member: AccountId, amount: U128);
    fn on_reserve_refund_complete(&mut self, funder: AccountId, amount: U128);
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
    round_deadlines: Vec<u64>,
    contributions: LookupMap<AccountId, u128>,
    guarantees: LookupMap<AccountId, Guarantee>,
    reserve_shares: LookupMap<AccountId, u128>,
    reserve_funders: Vec<AccountId>,
    treasurer_agent: AccountId,
    mode: CircleMode,
    protection_balance: u128,
    pending_protection_used: u128,
    pending_reserve_used_by: Vec<(AccountId, u128)>,
    payout_pending: bool,
    payout_complete: bool,
    circle_completed: bool,
    pending_guarantee_release: Option<AccountId>,
    pending_release_amount: u128,
    pending_reserve_refund: Option<AccountId>,
    pending_reserve_refund_amount: u128,
    // Lifetime verified contributions are retained when round-level records are cleared.
    total_contributions: LookupMap<AccountId, u128>,
    total_contributions_verified: bool,
    public_distribution_plan: Vec<(AccountId, u128)>,
    public_distribution_index: u32,
    public_distribution_pending: bool,
    public_distribution_complete: bool,
}

// Exact Borsh layout used by the previously deployed contract. Keep field order in sync
// with the legacy deployed state; LookupMap prefixes must remain unchanged during migration.
#[derive(BorshDeserialize, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct LegacyCircle {
    members: Vec<AccountId>,
    contribution_amount: u128,
    payout_order: Vec<AccountId>,
    current_round: u32,
    round_deadline: u64,
    contributions: LookupMap<AccountId, u128>,
    guarantees: LookupMap<AccountId, Guarantee>,
    reserve_shares: LookupMap<AccountId, u128>,
    reserve_funders: Vec<AccountId>,
    treasurer_agent: AccountId,
    mode: CircleMode,
    protection_balance: u128,
    pending_protection_used: u128,
    pending_reserve_used_by: Vec<(AccountId, u128)>,
    payout_pending: bool,
    payout_complete: bool,
    circle_completed: bool,
    pending_guarantee_release: Option<AccountId>,
    pending_release_amount: u128,
    pending_reserve_refund: Option<AccountId>,
    pending_reserve_refund_amount: u128,
}

// State layout immediately before lifetime contribution accounting was introduced.
// This is distinct from LegacyCircle, which predates the scheduled-deadlines field.
#[derive(BorshDeserialize, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct PreviousCircle {
    members: Vec<AccountId>,
    contribution_amount: u128,
    payout_order: Vec<AccountId>,
    current_round: u32,
    round_deadline: u64,
    round_deadlines: Vec<u64>,
    contributions: LookupMap<AccountId, u128>,
    guarantees: LookupMap<AccountId, Guarantee>,
    reserve_shares: LookupMap<AccountId, u128>,
    reserve_funders: Vec<AccountId>,
    treasurer_agent: AccountId,
    mode: CircleMode,
    protection_balance: u128,
    pending_protection_used: u128,
    pending_reserve_used_by: Vec<(AccountId, u128)>,
    payout_pending: bool,
    payout_complete: bool,
    circle_completed: bool,
    pending_guarantee_release: Option<AccountId>,
    pending_release_amount: u128,
    pending_reserve_refund: Option<AccountId>,
    pending_reserve_refund_amount: u128,
}

// Exact Circle layout immediately before public-distribution state was added.
#[derive(BorshDeserialize, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct DistributionPreviousCircle {
    members: Vec<AccountId>,
    contribution_amount: u128,
    payout_order: Vec<AccountId>,
    current_round: u32,
    round_deadline: u64,
    round_deadlines: Vec<u64>,
    contributions: LookupMap<AccountId, u128>,
    guarantees: LookupMap<AccountId, Guarantee>,
    reserve_shares: LookupMap<AccountId, u128>,
    reserve_funders: Vec<AccountId>,
    treasurer_agent: AccountId,
    mode: CircleMode,
    protection_balance: u128,
    pending_protection_used: u128,
    pending_reserve_used_by: Vec<(AccountId, u128)>,
    payout_pending: bool,
    payout_complete: bool,
    circle_completed: bool,
    pending_guarantee_release: Option<AccountId>,
    pending_release_amount: u128,
    pending_reserve_refund: Option<AccountId>,
    pending_reserve_refund_amount: u128,
    total_contributions: LookupMap<AccountId, u128>,
    total_contributions_verified: bool,
}

#[near_bindgen]
impl Circle {
    #[init]
    pub fn new(
        members: Vec<AccountId>,
        contribution_amount: U128,
        payout_order: Vec<AccountId>,
        round_deadline: u64,
        round_deadlines: Vec<u64>,
        treasurer_agent: AccountId,
        mode: CircleMode,
    ) -> Self {
        assert!(!env::state_exists(), "Contract is already initialized");
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Only the contract account may initialize this circle"
        );
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
        assert_eq!(
            members.len(),
            round_deadlines.len(),
            "Schedule must contain one deadline per member"
        );
        assert_eq!(
            round_deadlines.first().copied(),
            Some(round_deadline),
            "First scheduled deadline must match round deadline"
        );
        assert!(
            round_deadlines
                .iter()
                .all(|deadline| *deadline > env::block_timestamp()),
            "Every scheduled deadline must be in the future"
        );
        assert!(
            round_deadlines.windows(2).all(|pair| pair[0] < pair[1]),
            "Scheduled deadlines must be strictly increasing"
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
            round_deadlines,
            contributions: LookupMap::new(StorageKey::Contributions),
            guarantees: LookupMap::new(StorageKey::Guarantees),
            reserve_shares: LookupMap::new(StorageKey::ProtectionContributions),
            reserve_funders: Vec::new(),
            treasurer_agent,
            mode,
            protection_balance: 0,
            pending_protection_used: 0,
            pending_reserve_used_by: Vec::new(),
            payout_pending: false,
            payout_complete: false,
            circle_completed: false,
            pending_guarantee_release: None,
            pending_release_amount: 0,
            pending_reserve_refund: None,
            pending_reserve_refund_amount: 0,
            total_contributions: LookupMap::new(StorageKey::TotalContributions),
            total_contributions_verified: true,
            public_distribution_plan: Vec::new(),
            public_distribution_index: 0,
            public_distribution_pending: false,
            public_distribution_complete: false,
        }
    }

    /// Upgrade the legacy state without resetting persistent maps or circle accounting.
    /// The caller must provide the complete schedule; the active round may be rescheduled
    /// only when no member has contributed and no payout/async settlement is in flight.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(round_deadlines: Vec<u64>) -> Self {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Only the contract account may migrate this circle"
        );
        let legacy_bytes = env::storage_read(b"STATE")
            .expect("Legacy contract state is missing; migration refused");
        let legacy = LegacyCircle::try_from_slice(&legacy_bytes)
            .expect("Legacy contract state layout is invalid; migration refused");

        assert!(!legacy.members.is_empty(), "Legacy circle has no members");
        assert_eq!(
            legacy.members.len(),
            legacy.payout_order.len(),
            "Legacy payout order is invalid"
        );
        assert!(
            (legacy.current_round as usize) < legacy.members.len(),
            "Legacy current round is outside the schedule"
        );
        assert_eq!(
            round_deadlines.len(),
            legacy.members.len(),
            "Schedule must contain one deadline per member"
        );
        assert!(
            round_deadlines.windows(2).all(|pair| pair[0] < pair[1]),
            "Scheduled deadlines must be strictly increasing"
        );
        assert!(
            round_deadlines[legacy.current_round as usize] > env::block_timestamp(),
            "Active round deadline must be in the future"
        );
        assert!(
            round_deadlines[legacy.current_round as usize..]
                .iter()
                .all(|deadline| *deadline > env::block_timestamp()),
            "Current and future scheduled deadlines must be in the future"
        );
        let proposed_deadline = round_deadlines[legacy.current_round as usize];
        if proposed_deadline != legacy.round_deadline {
            assert!(
                legacy
                    .members
                    .iter()
                    .all(|member| legacy.contributions.get(member).is_none()),
                "Migration refused to reschedule a round with contributions"
            );
        }
        assert!(
            !legacy.payout_pending,
            "Migration refused while payout is pending"
        );
        assert!(
            !legacy.payout_complete,
            "Migration refused before round advancement"
        );
        assert!(
            !legacy.circle_completed,
            "Migration refused for a completed circle"
        );
        assert!(
            legacy.pending_guarantee_release.is_none(),
            "Migration refused during guarantee release"
        );
        assert_eq!(
            legacy.pending_release_amount, 0,
            "Migration refused with pending release amount"
        );
        assert!(
            legacy.pending_reserve_refund.is_none(),
            "Migration refused during reserve refund"
        );
        assert_eq!(
            legacy.pending_reserve_refund_amount, 0,
            "Migration refused with pending reserve refund amount"
        );
        assert_eq!(
            legacy.pending_protection_used, 0,
            "Migration refused with pending protection usage"
        );
        assert!(
            legacy.pending_reserve_used_by.is_empty(),
            "Migration refused with pending reserve usage"
        );

        let round_deadline = round_deadlines[legacy.current_round as usize];
        Self {
            members: legacy.members,
            contribution_amount: legacy.contribution_amount,
            payout_order: legacy.payout_order,
            current_round: legacy.current_round,
            round_deadline,
            round_deadlines,
            contributions: legacy.contributions,
            guarantees: legacy.guarantees,
            reserve_shares: legacy.reserve_shares,
            reserve_funders: legacy.reserve_funders,
            treasurer_agent: legacy.treasurer_agent,
            mode: legacy.mode,
            protection_balance: legacy.protection_balance,
            pending_protection_used: legacy.pending_protection_used,
            pending_reserve_used_by: legacy.pending_reserve_used_by,
            payout_pending: legacy.payout_pending,
            payout_complete: legacy.payout_complete,
            circle_completed: legacy.circle_completed,
            pending_guarantee_release: legacy.pending_guarantee_release,
            pending_release_amount: legacy.pending_release_amount,
            pending_reserve_refund: legacy.pending_reserve_refund,
            pending_reserve_refund_amount: legacy.pending_reserve_refund_amount,
            // Legacy state discarded completed-round contribution records. Do not claim
            // historical totals are verified after migration; public distribution stays blocked.
            total_contributions: LookupMap::new(StorageKey::TotalContributions),
            total_contributions_verified: false,
            public_distribution_plan: Vec::new(),
            public_distribution_index: 0,
            public_distribution_pending: false,
            public_distribution_complete: false,
        }
    }

    /// Upgrade the immediately previous Circle layout while preserving all existing state.
    /// Historical totals cannot be reconstructed from round records already cleared, so the
    /// new lifetime-total view intentionally remains unverified for this migrated instance.
    #[private]
    #[init(ignore_state)]
    pub fn migrate_v2(round_deadlines: Vec<u64>) -> Self {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Only the contract account may migrate this circle"
        );
        let previous: PreviousCircle =
            env::state_read().expect("No compatible previous Circle state found");
        assert!(
            !previous.members.is_empty(),
            "Previous circle has no members"
        );
        assert_eq!(
            previous.payout_order.len(),
            previous.members.len(),
            "Previous payout order is invalid"
        );
        assert_eq!(
            previous.round_deadlines.len(),
            previous.members.len(),
            "Previous schedule is invalid"
        );
        assert!(
            (previous.current_round as usize) < previous.members.len(),
            "Previous current round is outside the schedule"
        );
        assert_eq!(
            previous.round_deadlines[previous.current_round as usize], previous.round_deadline,
            "Previous active deadline does not match schedule"
        );
        assert_eq!(
            round_deadlines.len(),
            previous.members.len(),
            "Schedule must contain one deadline per member"
        );
        assert!(
            round_deadlines.windows(2).all(|pair| pair[0] < pair[1]),
            "Scheduled deadlines must be strictly increasing"
        );
        assert!(
            round_deadlines[previous.current_round as usize..]
                .iter()
                .all(|deadline| *deadline > env::block_timestamp()),
            "Current and future scheduled deadlines must be in the future"
        );
        if round_deadlines[previous.current_round as usize] != previous.round_deadline {
            assert!(
                previous
                    .members
                    .iter()
                    .all(|member| previous.contributions.get(member).is_none()),
                "Migration refused to reschedule a round with contributions"
            );
        }
        assert!(
            !previous.payout_pending,
            "Migration refused while payout is pending"
        );
        assert!(
            !previous.payout_complete,
            "Migration refused before round advancement"
        );
        assert!(
            !previous.circle_completed,
            "Migration refused for a completed circle"
        );
        assert!(
            previous.pending_guarantee_release.is_none(),
            "Migration refused during guarantee release"
        );
        assert_eq!(
            previous.pending_release_amount, 0,
            "Migration refused with pending release amount"
        );
        assert!(
            previous.pending_reserve_refund.is_none(),
            "Migration refused during reserve refund"
        );
        assert_eq!(
            previous.pending_reserve_refund_amount, 0,
            "Migration refused with pending reserve refund amount"
        );
        assert_eq!(
            previous.pending_protection_used, 0,
            "Migration refused with pending protection usage"
        );
        assert!(
            previous.pending_reserve_used_by.is_empty(),
            "Migration refused with pending reserve usage"
        );
        // At round zero, with no current-round contributions, there cannot be historical
        // contribution totals to lose. Later-round legacy state remains unverified because
        // completed rounds may already have cleared their per-round records.
        let totals_verified = previous.current_round == 0
            && previous
                .members
                .iter()
                .all(|member| previous.contributions.get(member).is_none());
        let round_deadline = round_deadlines[previous.current_round as usize];

        Self {
            members: previous.members,
            contribution_amount: previous.contribution_amount,
            payout_order: previous.payout_order,
            current_round: previous.current_round,
            round_deadline,
            round_deadlines,
            contributions: previous.contributions,
            guarantees: previous.guarantees,
            reserve_shares: previous.reserve_shares,
            reserve_funders: previous.reserve_funders,
            treasurer_agent: previous.treasurer_agent,
            mode: previous.mode,
            protection_balance: previous.protection_balance,
            pending_protection_used: previous.pending_protection_used,
            pending_reserve_used_by: previous.pending_reserve_used_by,
            payout_pending: previous.payout_pending,
            payout_complete: previous.payout_complete,
            circle_completed: previous.circle_completed,
            pending_guarantee_release: previous.pending_guarantee_release,
            pending_release_amount: previous.pending_release_amount,
            pending_reserve_refund: previous.pending_reserve_refund,
            pending_reserve_refund_amount: previous.pending_reserve_refund_amount,
            total_contributions: LookupMap::new(StorageKey::TotalContributions),
            total_contributions_verified: totals_verified,
            public_distribution_plan: Vec::new(),
            public_distribution_index: 0,
            public_distribution_pending: false,
            public_distribution_complete: false,
        }
    }

    /// Upgrade the immediately previous lifetime-accounting layout and preserve its verified totals.
    #[private]
    #[init(ignore_state)]
    pub fn migrate_v3() -> Self {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Only the contract account may migrate this circle"
        );
        let previous: DistributionPreviousCircle =
            env::state_read().expect("No compatible lifetime-accounting Circle state found");
        assert_eq!(
            previous.round_deadlines.len(),
            previous.members.len(),
            "Previous schedule is invalid"
        );
        assert!(
            (previous.current_round as usize) < previous.members.len(),
            "Previous current round is outside the schedule"
        );
        assert_eq!(
            previous.round_deadlines[previous.current_round as usize], previous.round_deadline,
            "Previous active deadline does not match schedule"
        );
        // A prior public round may already have paid a rotating recipient. Those historical
        // transfers cannot be reconstructed into a remaining distributable pool, so fail closed.
        let totals_verified = previous.total_contributions_verified
            && (previous.mode == CircleMode::Private
                || (previous.current_round == 0
                    && !previous.payout_pending
                    && !previous.payout_complete
                    && !previous.circle_completed));
        Self {
            members: previous.members,
            contribution_amount: previous.contribution_amount,
            payout_order: previous.payout_order,
            current_round: previous.current_round,
            round_deadline: previous.round_deadline,
            round_deadlines: previous.round_deadlines,
            contributions: previous.contributions,
            guarantees: previous.guarantees,
            reserve_shares: previous.reserve_shares,
            reserve_funders: previous.reserve_funders,
            treasurer_agent: previous.treasurer_agent,
            mode: previous.mode,
            protection_balance: previous.protection_balance,
            pending_protection_used: previous.pending_protection_used,
            pending_reserve_used_by: previous.pending_reserve_used_by,
            payout_pending: previous.payout_pending,
            payout_complete: previous.payout_complete,
            circle_completed: previous.circle_completed,
            pending_guarantee_release: previous.pending_guarantee_release,
            pending_release_amount: previous.pending_release_amount,
            pending_reserve_refund: previous.pending_reserve_refund,
            pending_reserve_refund_amount: previous.pending_reserve_refund_amount,
            total_contributions: previous.total_contributions,
            total_contributions_verified: totals_verified,
            public_distribution_plan: Vec::new(),
            public_distribution_index: 0,
            public_distribution_pending: false,
            public_distribution_complete: false,
        }
    }

    /// Repair an unstarted circle's schedule without resetting its persisted state.
    /// Only the configured treasurer account may call this, and only while the circle is idle.
    pub fn reschedule_unstarted_circle(&mut self, round_deadlines: Vec<u64>) {
        assert_eq!(
            env::predecessor_account_id(),
            self.treasurer_agent,
            "Only the treasurer agent may reschedule this circle"
        );
        assert_eq!(
            round_deadlines.len(),
            self.members.len(),
            "Schedule must contain one deadline per member"
        );
        assert!(
            round_deadlines.windows(2).all(|pair| pair[0] < pair[1]),
            "Scheduled deadlines must be strictly increasing"
        );
        assert!(
            round_deadlines[self.current_round as usize..]
                .iter()
                .all(|deadline| *deadline > env::block_timestamp()),
            "Current and future scheduled deadlines must be in the future"
        );
        assert!(
            self.members
                .iter()
                .all(|member| self.contributions.get(member).is_none()),
            "Cannot reschedule a round after contributions"
        );
        assert!(
            !self.payout_pending,
            "Cannot reschedule while payout is pending"
        );
        assert!(
            !self.payout_complete,
            "Cannot reschedule before round advancement"
        );
        assert!(
            !self.circle_completed,
            "Cannot reschedule a completed circle"
        );
        assert!(
            self.pending_guarantee_release.is_none(),
            "Cannot reschedule during guarantee release"
        );
        assert_eq!(
            self.pending_release_amount, 0,
            "Cannot reschedule with pending release amount"
        );
        assert!(
            self.pending_reserve_refund.is_none(),
            "Cannot reschedule during reserve refund"
        );
        assert_eq!(
            self.pending_reserve_refund_amount, 0,
            "Cannot reschedule with pending reserve refund amount"
        );
        assert_eq!(
            self.pending_protection_used, 0,
            "Cannot reschedule with pending protection usage"
        );
        assert!(
            self.pending_reserve_used_by.is_empty(),
            "Cannot reschedule with pending reserve usage"
        );

        self.round_deadline = round_deadlines[self.current_round as usize];
        self.round_deadlines = round_deadlines;
    }

    /// Reconcile a legacy migration only when round zero proves that lifetime contribution
    /// totals are empty, and set a fresh schedule in the same guarded operation.
    /// This is intentionally unavailable after any contribution or prior round.
    pub fn repair_unstarted_circle(&mut self, round_deadlines: Vec<u64>) {
        assert_eq!(
            env::predecessor_account_id(),
            self.treasurer_agent,
            "Only the treasurer agent may repair this circle"
        );
        assert!(
            !self.total_contributions_verified,
            "Lifetime totals are already verified"
        );
        assert_eq!(
            self.current_round, 0,
            "Empty lifetime totals can only be verified at round zero"
        );
        assert_eq!(
            self.contribution_count_internal(),
            0,
            "Cannot verify empty lifetime totals after contributions"
        );
        assert!(
            self.members
                .iter()
                .all(|member| self.contributions.get(member).is_none()),
            "Cannot verify empty lifetime totals after contributions"
        );
        assert!(
            self.members
                .iter()
                .all(|member| self.total_contributions.get(member).is_none()),
            "Cannot verify empty lifetime totals when historical totals exist"
        );
        assert_eq!(
            self.protection_balance, 0,
            "Cannot repair lifetime totals with a non-zero reserve"
        );
        assert!(
            self.reserve_funders.is_empty(),
            "Cannot repair lifetime totals with reserve funders"
        );
        assert!(
            self.members
                .iter()
                .all(|member| self.reserve_shares.get(member).unwrap_or(0) == 0),
            "Cannot repair lifetime totals with reserve shares"
        );
        assert!(
            self.members
                .iter()
                .all(|member| self.guarantees.get(member).is_none()),
            "Cannot repair lifetime totals with guarantee records"
        );
        assert!(
            !self.payout_pending && !self.payout_complete && !self.circle_completed,
            "Cannot repair lifetime totals during or after payout"
        );
        assert!(
            self.pending_guarantee_release.is_none() && self.pending_reserve_refund.is_none(),
            "Cannot repair lifetime totals during pending transfers"
        );
        assert_eq!(
            self.pending_release_amount, 0,
            "Cannot repair lifetime totals with pending release amount"
        );
        assert_eq!(
            self.pending_reserve_refund_amount, 0,
            "Cannot repair lifetime totals with pending refund amount"
        );
        assert_eq!(
            self.pending_protection_used, 0,
            "Cannot repair lifetime totals with pending protection usage"
        );
        assert!(
            self.pending_reserve_used_by.is_empty(),
            "Cannot repair lifetime totals with pending reserve usage"
        );
        assert!(
            self.public_distribution_plan.is_empty()
                && self.public_distribution_index == 0
                && !self.public_distribution_pending
                && !self.public_distribution_complete,
            "Cannot repair lifetime totals with distribution state"
        );

        self.reschedule_unstarted_circle(round_deadlines);
        self.total_contributions_verified = true;
    }

    /// Extend an expired active round deadline without clearing recorded contributions.
    /// The caller must be the contract account itself. The same positive offset is
    /// applied to this and later scheduled deadlines, preserving their spacing and
    /// all contribution/payout accounting.
    pub fn extend_expired_round_deadline(&mut self, new_deadline: u64) {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Only the contract treasurer may extend an expired round deadline"
        );
        assert!(!self.circle_completed, "Circle is already completed");
        assert!(
            !self.payout_pending,
            "Cannot extend deadline while payout is pending"
        );
        assert!(
            !self.payout_complete,
            "Cannot extend deadline before round advancement"
        );
        assert!(
            self.pending_guarantee_release.is_none(),
            "Cannot extend deadline during guarantee release"
        );
        assert_eq!(
            self.pending_release_amount, 0,
            "Cannot extend deadline with pending release amount"
        );
        assert!(
            self.pending_reserve_refund.is_none(),
            "Cannot extend deadline during reserve refund"
        );
        assert_eq!(
            self.pending_reserve_refund_amount, 0,
            "Cannot extend deadline with pending reserve refund amount"
        );
        assert_eq!(
            self.pending_protection_used, 0,
            "Cannot extend deadline with pending protection usage"
        );
        assert!(
            self.pending_reserve_used_by.is_empty(),
            "Cannot extend deadline with pending reserve usage"
        );

        let now = env::block_timestamp();
        assert!(
            self.round_deadline <= now,
            "Active round deadline has not expired"
        );
        assert!(new_deadline > now, "New deadline must be in the future");
        assert!(
            (self.current_round as usize) < self.round_deadlines.len(),
            "Current round is outside the schedule"
        );
        assert_eq!(
            self.round_deadlines[self.current_round as usize], self.round_deadline,
            "Active deadline does not match the schedule"
        );

        let shift = new_deadline
            .checked_sub(self.round_deadline)
            .expect("New deadline must extend the active deadline");
        for deadline in self
            .round_deadlines
            .iter_mut()
            .skip(self.current_round as usize)
        {
            *deadline = deadline
                .checked_add(shift)
                .expect("Rescheduled deadline overflow");
        }
        self.round_deadline = new_deadline;
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
        let lifetime_total = self.total_contributions.get(&member).unwrap_or(0);
        self.total_contributions.insert(
            &member,
            &lifetime_total
                .checked_add(self.contribution_amount)
                .expect("Lifetime contribution total overflow"),
        );

        // Emit a round-specific immutable event only after every contribution check
        // succeeds and the contribution has been recorded. The round index is the
        // contract's zero-based current_round value, matching the public contract state.
        let event = near_sdk::serde_json::json!({
            "standard": "ajocircle",
            "version": "1.0.0",
            "event": "contribution_recorded",
            "data": [{
                "member_id": member,
                "round": self.current_round,
                "amount_yocto": self.contribution_amount.to_string(),
            }],
        });
        env::log_str(&format!("EVENT_JSON:{event}"));
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

        assert!(
            self.pending_reserve_refund.is_none(),
            "A reserve refund is pending"
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

        assert!(
            self.pending_reserve_refund.is_none(),
            "A reserve refund is pending"
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
        let funder = env::predecessor_account_id();
        let previous = self.reserve_shares.get(&funder).unwrap_or(0);
        let updated = previous
            .checked_add(deposit)
            .expect("Reserve share overflow");
        self.reserve_shares.insert(&funder, &updated);
        if previous == 0 {
            self.reserve_funders.push(funder);
        }
        self.protection_balance = self
            .protection_balance
            .checked_add(deposit)
            .expect("Protection balance overflow");
    }

    pub fn get_reserve_share(&self, funder: AccountId) -> U128 {
        U128(self.reserve_shares.get(&funder).unwrap_or(0))
    }

    pub fn refund_protection(&mut self) -> Promise {
        assert!(
            self.circle_completed,
            "Circle must be completed before reserve refunds"
        );
        assert!(!self.payout_pending, "A payout is still pending");
        assert!(
            self.pending_guarantee_release.is_none(),
            "A collateral release is pending"
        );
        assert!(
            self.pending_reserve_refund.is_none(),
            "A reserve refund is already pending"
        );
        assert!(
            self.pending_guarantee_release.is_none(),
            "A collateral release is pending"
        );

        let funder = env::predecessor_account_id();
        let amount = self.reserve_shares.get(&funder).unwrap_or(0);
        assert!(amount > 0, "No refundable reserve balance");
        self.reserve_shares.insert(&funder, &0);
        self.protection_balance = self
            .protection_balance
            .checked_sub(amount)
            .expect("Reserve share exceeds available protection balance");
        self.pending_reserve_refund = Some(funder.clone());
        self.pending_reserve_refund_amount = amount;

        Promise::new(funder.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_reserve_refund_complete(funder, U128(amount)),
            )
    }

    #[private]
    pub fn on_reserve_refund_complete(&mut self, funder: AccountId, amount: U128) {
        assert_eq!(
            self.pending_reserve_refund.as_ref(),
            Some(&funder),
            "No matching reserve refund is pending"
        );
        assert_eq!(
            self.pending_reserve_refund_amount, amount.0,
            "Reserve refund amount does not match pending amount"
        );

        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                self.pending_reserve_refund = None;
                self.pending_reserve_refund_amount = 0;
            }
            _ => {
                let share = self.reserve_shares.get(&funder).unwrap_or(0);
                self.reserve_shares.insert(
                    &funder,
                    &share
                        .checked_add(amount.0)
                        .expect("Reserve share overflow while restoring failed refund"),
                );
                self.protection_balance = self
                    .protection_balance
                    .checked_add(amount.0)
                    .expect("Protection balance overflow while restoring failed refund");
                self.pending_reserve_refund = None;
                self.pending_reserve_refund_amount = 0;
            }
        }
    }

    /// Public circles finish each round without paying a rotating recipient.
    pub fn complete_public_round(&mut self) {
        self.assert_treasurer();
        assert_eq!(
            self.mode,
            CircleMode::ProtectedPublic,
            "Only public circles use public-round completion"
        );
        assert!(!self.circle_completed, "Circle is already completed");
        assert!(
            !self.payout_pending && !self.payout_complete,
            "A payout/round completion is already pending or complete"
        );
        assert!(
            self.pending_guarantee_release.is_none(),
            "A guarantee release is pending"
        );
        assert!(
            self.pending_reserve_refund.is_none(),
            "A reserve refund is pending"
        );
        assert_eq!(
            self.contribution_count_internal(),
            self.members.len(),
            "Every member must contribute before a public round can complete"
        );
        self.payout_complete = true;
        if (self.current_round as usize) + 1 >= self.round_deadlines.len() {
            self.circle_completed = true;
        }
    }

    /// Public circles may not use the legacy rotating-recipient payout.
    pub fn release_payout(&mut self) -> Promise {
        self.assert_treasurer();
        assert_eq!(
            self.mode,
            CircleMode::Private,
            "Public circles require proportional distribution after all rounds"
        );
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
            let mut remaining_shortfall = shortfall;
            for funder in self.reserve_funders.clone() {
                if remaining_shortfall == 0 {
                    break;
                }
                let share = self.reserve_shares.get(&funder).unwrap_or(0);
                let used = share.min(remaining_shortfall);
                self.reserve_shares.insert(&funder, &(share - used));
                if used > 0 {
                    self.pending_reserve_used_by.push((funder, used));
                }
                remaining_shortfall -= used;
            }
            // Any remainder may come from claimed guarantee collateral, which is not refundable to reserve funders.
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

    /// Build a deterministic proportional distribution from verified on-chain contribution totals.
    /// Transfer plan is stored before the first promise; one transfer is in flight at a time.
    pub fn start_public_distribution(&mut self) -> Promise {
        self.assert_treasurer();
        assert_eq!(
            self.mode,
            CircleMode::ProtectedPublic,
            "Only public circles use proportional distribution"
        );
        assert!(
            self.circle_completed,
            "Every public round must complete before distribution"
        );
        assert!(
            self.total_contributions_verified,
            "Lifetime contribution totals are unverified"
        );
        assert!(
            !self.payout_pending
                && self.pending_guarantee_release.is_none()
                && self.pending_reserve_refund.is_none(),
            "Another settlement is pending"
        );
        assert!(
            !self.public_distribution_pending
                && !self.public_distribution_complete
                && self.public_distribution_plan.is_empty(),
            "Public distribution has already started"
        );
        let mut members = self.members.clone();
        members.sort();
        assert_eq!(
            self.protection_balance, 0,
            "Resolve public protection obligations before distribution"
        );
        let mut plan: Vec<(AccountId, u128)> = Vec::new();
        let mut pool: u128 = 0;
        for member in members {
            let amount = self.total_contributions.get(&member).unwrap_or(0);
            assert!(
                amount > 0,
                "Every eligible public member must have verified contributions"
            );
            assert_eq!(
                self.reserve_shares.get(&member).unwrap_or(0),
                0,
                "Resolve reserve-funder obligations before distribution"
            );
            if let Some(guarantee) = self.guarantees.get(&member) {
                assert_eq!(
                    guarantee.locked_amount, 0,
                    "Resolve guarantee collateral before distribution"
                );
            }
            pool = pool
                .checked_add(amount)
                .expect("Contribution pool overflow");
            plan.push((member, amount));
        }
        assert!(pool > 0, "No distributable contributions recorded");
        let storage_reserve = (env::storage_usage() as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("Storage reserve overflow");
        let required_balance = pool
            .checked_add(storage_reserve)
            .expect("Required contract balance overflow");
        assert!(
            env::account_balance().as_yoctonear() >= required_balance,
            "Contract balance cannot cover distribution and recorded reserve obligations"
        );
        self.public_distribution_plan = plan;
        self.public_distribution_index = 0;
        self.public_distribution_pending = true;
        self.send_public_distribution_transfer()
    }

    /// Retry the current item only after a failed transfer callback cleared the pending flag.
    pub fn continue_public_distribution(&mut self) -> Promise {
        self.assert_treasurer();
        assert_eq!(
            self.mode,
            CircleMode::ProtectedPublic,
            "Only public circles use proportional distribution"
        );
        assert!(
            !self.public_distribution_complete,
            "Public distribution is already complete"
        );
        assert!(
            !self.public_distribution_pending,
            "A distribution transfer is already pending"
        );
        assert!(
            !self.public_distribution_plan.is_empty(),
            "Public distribution has not started"
        );
        assert!(
            (self.public_distribution_index as usize) < self.public_distribution_plan.len(),
            "No distribution item remains"
        );
        let remaining_pool = self
            .public_distribution_plan
            .iter()
            .skip(self.public_distribution_index as usize)
            .try_fold(0u128, |sum, (_, amount)| sum.checked_add(*amount))
            .expect("Remaining distribution pool overflow");
        let storage_reserve = (env::storage_usage() as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("Storage reserve overflow");
        let required_balance = remaining_pool
            .checked_add(storage_reserve)
            .expect("Required contract balance overflow");
        assert!(
            env::account_balance().as_yoctonear() >= required_balance,
            "Contract balance cannot cover remaining distribution and storage reserve"
        );
        self.public_distribution_pending = true;
        self.send_public_distribution_transfer()
    }

    fn send_public_distribution_transfer(&self) -> Promise {
        let (recipient, amount) = self
            .public_distribution_plan
            .get(self.public_distribution_index as usize)
            .expect("Distribution index is out of range");
        Promise::new(recipient.clone())
            .transfer(NearToken::from_yoctonear(*amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_public_distribution_transfer(),
            )
    }

    #[private]
    pub fn on_public_distribution_transfer(&mut self) {
        assert!(
            self.public_distribution_pending,
            "No public distribution transfer is pending"
        );
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                self.public_distribution_pending = false;
                self.public_distribution_index = self
                    .public_distribution_index
                    .checked_add(1)
                    .expect("Distribution index overflow");
                if self.public_distribution_index as usize >= self.public_distribution_plan.len() {
                    self.public_distribution_complete = true;
                }
            }
            _ => {
                // Keep the same index so the treasurer can safely retry this recipient.
                self.public_distribution_pending = false;
            }
        }
    }

    #[private]
    pub fn on_payout_complete(&mut self) {
        assert!(self.payout_pending, "No payout is pending");
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                self.payout_pending = false;
                self.payout_complete = true;
                self.pending_protection_used = 0;
                self.pending_reserve_used_by.clear();
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
                for (funder, amount) in self.pending_reserve_used_by.drain(..) {
                    let share = self.reserve_shares.get(&funder).unwrap_or(0);
                    let restored = share
                        .checked_add(amount)
                        .expect("Reserve share overflow while restoring failed payout");
                    self.reserve_shares.insert(&funder, &restored);
                }
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
        let next_round = self
            .current_round
            .checked_add(1)
            .expect("Round counter overflow");
        let scheduled_deadline = *self
            .round_deadlines
            .get(next_round as usize)
            .expect("No scheduled round remains");
        let now = env::block_timestamp();
        assert!(new_deadline > now, "Next deadline must be in the future");
        if scheduled_deadline > now {
            assert_eq!(
                new_deadline, scheduled_deadline,
                "Next deadline must match the preconfigured schedule"
            );
        } else {
            // Recovery path: if the next scheduled deadline expired before the
            // completed round could advance, move that deadline and all later
            // deadlines forward by the same offset. This preserves interval
            // spacing and schedule ordering without touching payout accounting.
            let shift = new_deadline - scheduled_deadline;
            for deadline in self.round_deadlines.iter_mut().skip(next_round as usize) {
                *deadline = deadline
                    .checked_add(shift)
                    .expect("Rescheduled deadline overflow");
            }
        }
        for member in &self.members {
            self.contributions.remove(member);
        }
        self.current_round = next_round;
        self.round_deadline = new_deadline;
        self.payout_complete = false;
    }

    pub fn get_round(&self) -> u32 {
        self.current_round
    }
    pub fn get_round_deadline(&self) -> U64 {
        U64(self.round_deadline)
    }
    pub fn get_round_deadlines(&self) -> Vec<U64> {
        self.round_deadlines.iter().copied().map(U64).collect()
    }
    pub fn get_contribution_count(&self) -> u32 {
        self.contribution_count_internal() as u32
    }
    pub fn get_contribution(&self, member: AccountId) -> Option<U128> {
        self.contributions.get(&member).map(U128)
    }

    /// Total native NEAR contributions recorded for a member across all rounds.
    /// Legacy-upgraded circles return no verified total until an explicit reconciliation path exists.
    pub fn get_total_contribution(&self, member: AccountId) -> Option<U128> {
        if !self.total_contributions_verified {
            return None;
        }
        self.total_contributions.get(&member).map(U128)
    }

    pub fn are_total_contributions_verified(&self) -> bool {
        self.total_contributions_verified
    }

    pub fn get_public_distribution_plan(&self) -> Vec<(AccountId, U128)> {
        self.public_distribution_plan
            .iter()
            .map(|(member, amount)| (member.clone(), U128(*amount)))
            .collect()
    }

    pub fn get_public_distribution_index(&self) -> u32 {
        self.public_distribution_index
    }

    pub fn is_public_distribution_pending(&self) -> bool {
        self.public_distribution_pending
    }

    pub fn is_public_distribution_complete(&self) -> bool {
        self.public_distribution_complete
    }

    pub fn get_current_recipient(&self) -> AccountId {
        self.payout_order[(self.current_round as usize) % self.payout_order.len()].clone()
    }
    pub fn get_mode(&self) -> CircleMode {
        self.mode
    }

    /// Immutable configuration views used to verify local/on-chain schedule parity.
    pub fn get_members(&self) -> Vec<AccountId> {
        self.members.clone()
    }

    pub fn get_member_count(&self) -> u32 {
        self.members.len() as u32
    }

    pub fn get_contribution_amount(&self) -> U128 {
        U128(self.contribution_amount)
    }

    pub fn get_payout_order(&self) -> Vec<AccountId> {
        self.payout_order.clone()
    }

    pub fn get_treasurer_agent(&self) -> AccountId {
        self.treasurer_agent.clone()
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
            .account_balance(NearToken::from_yoctonear(
                1_000_000_000_000_000_000_000_000_000,
            ))
            .block_timestamp(timestamp);
        testing_env!(builder.build());
    }

    fn sample_circle(mode: CircleMode) -> Circle {
        context("circle.near", 0);
        Circle::new(
            vec![account("alice.near"), account("bob.near")],
            U128(CONTRIBUTION),
            vec![account("alice.near"), account("bob.near")],
            NOW + 1_000_000_000,
            vec![NOW + 1_000_000_000, NOW + 2_000_000_000],
            account("treasurer.near"),
            mode,
        )
    }

    fn sample_previous_circle() -> PreviousCircle {
        let circle = sample_circle(CircleMode::ProtectedPublic);
        PreviousCircle {
            members: circle.members,
            contribution_amount: circle.contribution_amount,
            payout_order: circle.payout_order,
            current_round: circle.current_round,
            round_deadline: circle.round_deadline,
            round_deadlines: circle.round_deadlines,
            contributions: circle.contributions,
            guarantees: circle.guarantees,
            reserve_shares: circle.reserve_shares,
            reserve_funders: circle.reserve_funders,
            treasurer_agent: circle.treasurer_agent,
            mode: circle.mode,
            protection_balance: circle.protection_balance,
            pending_protection_used: circle.pending_protection_used,
            pending_reserve_used_by: circle.pending_reserve_used_by,
            payout_pending: circle.payout_pending,
            payout_complete: circle.payout_complete,
            circle_completed: circle.circle_completed,
            pending_guarantee_release: circle.pending_guarantee_release,
            pending_release_amount: circle.pending_release_amount,
            pending_reserve_refund: circle.pending_reserve_refund,
            pending_reserve_refund_amount: circle.pending_reserve_refund_amount,
        }
    }

    #[test]
    fn lifetime_contribution_totals_are_recorded_separately_from_round_records() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("alice.near", CONTRIBUTION);
        circle.contribute();
        assert_eq!(
            circle.get_contribution(account("alice.near")),
            Some(U128(CONTRIBUTION))
        );
        assert_eq!(
            circle.get_total_contribution(account("alice.near")),
            Some(U128(CONTRIBUTION))
        );
        assert_eq!(circle.get_total_contribution(account("bob.near")), None);
        assert!(circle.are_total_contributions_verified());
    }

    #[test]
    fn public_distribution_is_sorted_verified_and_retryable_without_advancing_on_failure() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        contribute_all_members(&mut circle);
        context("treasurer.near", 0);
        circle.complete_public_round();
        circle.advance_round(NOW + 2_000_000_000);
        contribute_all_members(&mut circle);
        context("treasurer.near", 0);
        circle.complete_public_round();
        assert!(circle.is_circle_completed());

        let _ = circle.start_public_distribution();
        assert!(circle.is_public_distribution_pending());
        assert_eq!(
            circle.get_public_distribution_plan(),
            vec![
                (account("alice.near"), U128(2 * CONTRIBUTION)),
                (account("bob.near"), U128(2 * CONTRIBUTION)),
            ]
        );
        assert_eq!(circle.get_public_distribution_index(), 0);

        let callback_context = VMContextBuilder::new()
            .current_account_id(account("circle.near"))
            .predecessor_account_id(account("circle.near"))
            .build();
        testing_env_with_promise_results(callback_context, PromiseResult::Successful(Vec::new()));
        circle.on_public_distribution_transfer();
        assert_eq!(circle.get_public_distribution_index(), 1);
        assert!(!circle.is_public_distribution_pending());

        context("treasurer.near", 0);
        let _ = circle.continue_public_distribution();
        let callback_context = VMContextBuilder::new()
            .current_account_id(account("circle.near"))
            .predecessor_account_id(account("circle.near"))
            .build();
        testing_env_with_promise_results(callback_context, PromiseResult::Failed);
        circle.on_public_distribution_transfer();
        assert_eq!(circle.get_public_distribution_index(), 1);
        assert!(!circle.is_public_distribution_pending());

        context("treasurer.near", 0);
        let _ = circle.continue_public_distribution();
        let callback_context = VMContextBuilder::new()
            .current_account_id(account("circle.near"))
            .predecessor_account_id(account("circle.near"))
            .build();
        testing_env_with_promise_results(callback_context, PromiseResult::Successful(Vec::new()));
        circle.on_public_distribution_transfer();
        assert_eq!(circle.get_public_distribution_index(), 2);
        assert!(circle.is_public_distribution_complete());
        assert!(!circle.is_public_distribution_pending());
    }

    #[test]
    #[should_panic(expected = "Public circles require proportional distribution after all rounds")]
    fn public_circle_rejects_legacy_rotating_payout() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        contribute_all_members(&mut circle);
        context("treasurer.near", 0);
        let _ = circle.release_payout();
    }

    #[test]
    #[should_panic(expected = "Every public round must complete before distribution")]
    fn public_distribution_is_blocked_until_every_round_completes() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("treasurer.near", 0);
        let _ = circle.start_public_distribution();
    }

    #[test]
    fn treasurer_can_reschedule_unstarted_circle_without_resetting_state() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context_at("treasurer.near", 0, NOW + 10);
        let updated = vec![NOW + 3_000_000_000, NOW + 4_000_000_000];
        circle.reschedule_unstarted_circle(updated.clone());
        assert_eq!(circle.get_round_deadline(), U64(updated[0]));
        assert_eq!(
            circle.get_round_deadlines(),
            updated.into_iter().map(U64).collect::<Vec<_>>()
        );
        assert_eq!(
            circle.get_members(),
            vec![account("alice.near"), account("bob.near")]
        );
        assert_eq!(circle.get_round(), 0);
    }

    #[test]
    #[should_panic(expected = "Only the treasurer agent may reschedule this circle")]
    fn reschedule_rejects_non_treasurer() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context_at("alice.near", 0, NOW + 10);
        circle.reschedule_unstarted_circle(vec![NOW + 3_000_000_000, NOW + 4_000_000_000]);
    }

    fn sample_legacy_circle() -> LegacyCircle {
        LegacyCircle {
            members: vec![account("alice.near"), account("bob.near")],
            contribution_amount: CONTRIBUTION,
            payout_order: vec![account("alice.near"), account("bob.near")],
            current_round: 0,
            round_deadline: NOW + 1_000_000_000,
            contributions: LookupMap::new(StorageKey::Contributions),
            guarantees: LookupMap::new(StorageKey::Guarantees),
            reserve_shares: LookupMap::new(StorageKey::ProtectionContributions),
            reserve_funders: vec![account("alice.near")],
            treasurer_agent: account("treasurer.near"),
            mode: CircleMode::ProtectedPublic,
            protection_balance: 23,
            pending_protection_used: 0,
            pending_reserve_used_by: Vec::new(),
            payout_pending: false,
            payout_complete: false,
            circle_completed: false,
            pending_guarantee_release: None,
            pending_release_amount: 0,
            pending_reserve_refund: None,
            pending_reserve_refund_amount: 0,
        }
    }

    #[test]
    fn migration_v2_preserves_previous_layout_and_reschedules_unstarted_circle() {
        context("circle.near", 0);
        let mut previous = sample_previous_circle();
        previous.reserve_shares.insert(&account("alice.near"), &17);
        previous.reserve_funders.push(account("alice.near"));
        env::state_write(&previous);

        let migrated = Circle::migrate_v2(vec![NOW + 3_000_000_000, NOW + 4_000_000_000]);

        assert_eq!(
            migrated.get_members(),
            vec![account("alice.near"), account("bob.near")]
        );
        assert_eq!(migrated.get_round(), 0);
        assert_eq!(migrated.get_round_deadline(), U64(NOW + 3_000_000_000));
        assert_eq!(
            migrated.get_round_deadlines(),
            vec![U64(NOW + 3_000_000_000), U64(NOW + 4_000_000_000)]
        );
        assert_eq!(
            migrated.reserve_shares.get(&account("alice.near")),
            Some(17)
        );
        assert_eq!(migrated.reserve_funders, vec![account("alice.near")]);
        assert!(migrated.total_contributions_verified);
        env::state_write(&migrated);
        let persisted: Circle = env::state_read().expect("Migrated v2 state must deserialize");
        assert_eq!(
            persisted.get_round_deadlines(),
            migrated.get_round_deadlines()
        );
        assert_eq!(
            persisted.reserve_shares.get(&account("alice.near")),
            Some(17)
        );
    }

    #[test]
    #[should_panic(expected = "Migration refused to reschedule a round with contributions")]
    fn migration_v2_refuses_to_reschedule_when_a_member_contributed() {
        context("circle.near", 0);
        let mut previous = sample_previous_circle();
        previous
            .contributions
            .insert(&account("alice.near"), &CONTRIBUTION);
        env::state_write(&previous);
        let _ = Circle::migrate_v2(vec![NOW + 3_000_000_000, NOW + 4_000_000_000]);
    }

    #[test]
    fn repair_unstarted_circle_verifies_empty_totals_and_reschedules_atomically() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        circle.total_contributions_verified = false;
        context("treasurer.near", 0);
        let deadlines = vec![NOW + 86_400_000_000_000, NOW + 172_800_000_000_000];

        circle.repair_unstarted_circle(deadlines.clone());

        assert!(circle.are_total_contributions_verified());
        assert_eq!(circle.get_round_deadline(), U64(deadlines[0]));
        assert_eq!(
            circle.get_round_deadlines(),
            deadlines.into_iter().map(U64).collect::<Vec<_>>()
        );
    }

    #[test]
    #[should_panic(expected = "Cannot verify empty lifetime totals after contributions")]
    fn repair_unstarted_circle_refuses_to_verify_totals_after_a_contribution() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("alice.near", CONTRIBUTION);
        circle.contribute();
        circle.total_contributions_verified = false;
        context("treasurer.near", 0);

        circle.repair_unstarted_circle(vec![NOW + 86_400_000_000_000, NOW + 172_800_000_000_000]);
    }

    #[test]
    fn migration_v2_keeps_lifetime_totals_unverified_after_earlier_rounds() {
        context("circle.near", 0);
        let mut previous = sample_previous_circle();
        previous.current_round = 1;
        previous.round_deadline = previous.round_deadlines[1];
        env::state_write(&previous);

        let migrated = Circle::migrate_v2(previous.round_deadlines.clone());

        assert!(!migrated.total_contributions_verified);
    }

    #[test]
    fn migration_preserves_legacy_accounting_and_storage_maps() {
        context("circle.near", 0);
        let mut legacy = sample_legacy_circle();
        legacy.reserve_shares.insert(&account("alice.near"), &17);
        env::state_write(&legacy);

        let migrated = Circle::migrate(vec![NOW + 3_000_000_000, NOW + 4_000_000_000]);

        assert_eq!(migrated.get_members(), legacy.members);
        assert_eq!(migrated.get_payout_order(), legacy.payout_order);
        assert_eq!(migrated.current_round, legacy.current_round);
        assert_eq!(migrated.get_round_deadline(), U64(NOW + 3_000_000_000));
        assert_eq!(
            migrated.get_round_deadlines(),
            vec![U64(NOW + 3_000_000_000), U64(NOW + 4_000_000_000)]
        );
        assert_eq!(migrated.get_protection_balance(), U128(23));
        assert_eq!(migrated.reserve_funders, vec![account("alice.near")]);
        assert_eq!(
            migrated.reserve_shares.get(&account("alice.near")),
            Some(17)
        );
        assert_eq!(migrated.get_mode(), CircleMode::ProtectedPublic);

        // Exercise the serialized state shape that the NEAR wrapper persists after return.
        env::state_write(&migrated);
        let persisted: Circle = env::state_read().expect("Migrated state must deserialize");
        assert_eq!(persisted.get_members(), legacy.members);
        assert_eq!(
            persisted.get_round_deadlines(),
            migrated.get_round_deadlines()
        );
        assert_eq!(
            persisted.reserve_shares.get(&account("alice.near")),
            Some(17)
        );
    }

    #[test]
    #[should_panic(expected = "Only the contract account may migrate this circle")]
    fn migration_rejects_external_caller() {
        context("outsider.near", 0);
        env::state_write(&sample_legacy_circle());
        let _ = Circle::migrate(vec![NOW + 3_000_000_000, NOW + 4_000_000_000]);
    }

    #[test]
    fn migration_preserves_contributions_when_deadline_is_unchanged() {
        context("circle.near", 0);
        let mut legacy = sample_legacy_circle();
        legacy
            .contributions
            .insert(&account("alice.near"), &CONTRIBUTION);
        env::state_write(&legacy);

        let migrated = Circle::migrate(vec![NOW + 1_000_000_000, NOW + 2_000_000_000]);

        assert_eq!(
            migrated.contributions.get(&account("alice.near")),
            Some(CONTRIBUTION)
        );
        assert_eq!(migrated.get_round_deadline(), U64(NOW + 1_000_000_000));
    }

    #[test]
    #[should_panic(expected = "Migration refused to reschedule a round with contributions")]
    fn migration_refuses_to_reschedule_a_round_with_contributions() {
        context("circle.near", 0);
        let mut legacy = sample_legacy_circle();
        legacy
            .contributions
            .insert(&account("alice.near"), &CONTRIBUTION);
        env::state_write(&legacy);
        let _ = Circle::migrate(vec![NOW + 3_000_000_000, NOW + 4_000_000_000]);
    }

    #[test]
    #[should_panic(expected = "Schedule must contain one deadline per member")]
    fn migration_rejects_incomplete_schedule() {
        context("circle.near", 0);
        env::state_write(&sample_legacy_circle());
        let _ = Circle::migrate(vec![NOW + 3_000_000_000]);
    }

    #[test]
    #[should_panic(expected = "Schedule must contain one deadline per member")]
    fn rejects_incomplete_round_schedule() {
        context("circle.near", 0);
        let _ = Circle::new(
            vec![account("alice.near"), account("bob.near")],
            U128(CONTRIBUTION),
            vec![account("alice.near"), account("bob.near")],
            NOW + 1_000_000_000,
            vec![NOW + 1_000_000_000],
            account("treasurer.near"),
            CircleMode::ProtectedPublic,
        );
    }

    #[test]
    #[should_panic(expected = "Next deadline must match the preconfigured schedule")]
    fn rejects_round_advance_to_an_unconfigured_deadline() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("treasurer.near", 0);
        circle.payout_complete = true;
        circle.advance_round(NOW + 3_000_000_000);
    }

    #[test]
    fn completed_round_can_recover_expired_schedule_without_changing_payout_accounting() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        circle.payout_complete = true;
        // The next configured deadline and later deadlines are already expired.
        context_at("treasurer.near", 0, NOW + 5_000_000_000);
        let recovered_deadline = NOW + 6_000_000_000;
        circle.advance_round(recovered_deadline);
        assert_eq!(circle.get_round(), 1);
        assert_eq!(circle.get_round_deadline(), U64(recovered_deadline));
        assert_eq!(
            circle.get_round_deadlines(),
            vec![U64(NOW + 1_000_000_000), U64(recovered_deadline)]
        );
        assert!(!circle.is_payout_complete());
        assert_eq!(circle.get_contribution_count(), 0);
    }

    #[test]
    #[should_panic(expected = "Next deadline must be in the future")]
    fn expired_schedule_recovery_rejects_deadline_not_in_future() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        circle.payout_complete = true;
        context_at("treasurer.near", 0, NOW + 5_000_000_000);
        circle.advance_round(NOW + 4_000_000_000);
    }

    #[test]
    fn expired_round_deadline_can_be_extended_without_losing_contributions_or_accounting() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        circle.current_round = 1;
        circle.round_deadlines = vec![NOW + 1_000_000_000, NOW + 2_000_000_000];
        circle.round_deadline = NOW + 2_000_000_000;
        circle
            .contributions
            .insert(&account("alice.near"), &CONTRIBUTION);
        circle.protection_balance = 77;
        context_at("circle.near", 0, NOW + 5_000_000_000);

        circle.extend_expired_round_deadline(NOW + 6_000_000_000);

        assert_eq!(circle.get_round(), 1);
        assert_eq!(circle.get_round_deadline(), U64(NOW + 6_000_000_000));
        assert_eq!(
            circle.get_round_deadlines(),
            vec![U64(NOW + 1_000_000_000), U64(NOW + 6_000_000_000)]
        );
        assert_eq!(circle.get_contribution_count(), 1);
        assert_eq!(
            circle.get_contribution(account("alice.near")),
            Some(U128(CONTRIBUTION))
        );
        assert_eq!(circle.protection_balance, 77);
        assert!(!circle.is_payout_pending());
        assert!(!circle.is_payout_complete());
    }

    #[test]
    #[should_panic(expected = "Active round deadline has not expired")]
    fn deadline_extension_rejects_unexpired_round() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context_at("circle.near", 0, NOW);
        circle.extend_expired_round_deadline(NOW + 3_000_000_000);
    }

    #[test]
    #[should_panic(expected = "Only the contract treasurer may extend an expired round deadline")]
    fn deadline_extension_rejects_non_contract_caller() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context_at("attacker.near", 0, NOW + 5_000_000_000);
        circle.extend_expired_round_deadline(NOW + 6_000_000_000);
    }

    #[test]
    fn exposes_immutable_circle_configuration_for_schedule_verification() {
        let circle = sample_circle(CircleMode::ProtectedPublic);
        assert_eq!(
            circle.get_members(),
            vec![account("alice.near"), account("bob.near")]
        );
        assert_eq!(circle.get_member_count(), 2);
        assert_eq!(circle.get_contribution_amount(), U128(CONTRIBUTION));
        assert_eq!(
            circle.get_payout_order(),
            vec![account("alice.near"), account("bob.near")]
        );
        assert_eq!(circle.get_round_deadline(), U64(NOW + 1_000_000_000));
        assert_eq!(
            circle.get_round_deadlines(),
            vec![U64(NOW + 1_000_000_000), U64(NOW + 2_000_000_000)]
        );
        assert_eq!(circle.get_treasurer_agent(), account("treasurer.near"));
        assert_eq!(circle.get_mode(), CircleMode::ProtectedPublic);
    }

    #[test]
    #[should_panic(expected = "Only the contract account may initialize this circle")]
    fn rejects_external_initializer() {
        context("outsider.near", 0);
        let _ = Circle::new(
            vec![account("alice.near")],
            U128(CONTRIBUTION),
            vec![account("alice.near")],
            NOW + 1_000_000_000,
            vec![NOW + 1_000_000_000],
            account("treasurer.near"),
            CircleMode::Private,
        );
    }

    #[test]
    #[should_panic(expected = "Contract is already initialized")]
    fn rejects_second_initialization() {
        let existing = sample_circle(CircleMode::Private);
        env::state_write(&existing);
        let _ = Circle::new(
            vec![account("alice.near")],
            U128(CONTRIBUTION),
            vec![account("alice.near")],
            NOW + 1_000_000_000,
            vec![NOW + 1_000_000_000],
            account("treasurer.near"),
            CircleMode::Private,
        );
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
    #[should_panic(expected = "Every member must contribute before a public round can complete")]
    fn public_round_cannot_complete_when_a_member_missed_a_contribution() {
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
        circle.complete_public_round();
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
    fn contribution_emits_round_bound_event_only_after_recording() {
        let mut circle = sample_circle(CircleMode::Private);
        context("alice.near", CONTRIBUTION);
        circle.contribute();
        let logs = near_sdk::test_utils::get_logs();
        assert_eq!(logs.len(), 1);
        let raw = logs[0].strip_prefix("EVENT_JSON:").expect("event prefix");
        let event: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(raw).unwrap();
        assert_eq!(event["standard"], "ajocircle");
        assert_eq!(event["version"], "1.0.0");
        assert_eq!(event["event"], "contribution_recorded");
        assert_eq!(event["data"][0]["member_id"], "alice.near");
        assert_eq!(event["data"][0]["round"], 0);
        assert_eq!(event["data"][0]["amount_yocto"], CONTRIBUTION.to_string());
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
        if circle.mode == CircleMode::ProtectedPublic {
            circle.complete_public_round();
        } else {
            let _ = circle.release_payout();
            let callback_context = VMContextBuilder::new()
                .current_account_id(account("circle.near"))
                .predecessor_account_id(account("circle.near"))
                .block_timestamp(NOW + 1_000_000_000)
                .build();
            testing_env_with_promise_results(
                callback_context,
                PromiseResult::Successful(Vec::new()),
            );
            circle.on_payout_complete();
        }
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

    fn completed_circle_with_guarantee_and_reserve_funder() -> Circle {
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
        context("sponsor.near", 2 * CONTRIBUTION);
        circle.fund_protection();
        complete_current_payout(&mut circle);
        context("treasurer.near", 0);
        circle.advance_round(NOW + 2_000_000_000);
        complete_current_payout(&mut circle);
        assert!(circle.is_circle_completed());
        circle
    }

    fn completed_circle_with_reserve_funder() -> Circle {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("sponsor.near", 2 * CONTRIBUTION);
        circle.fund_protection();
        complete_current_payout(&mut circle);
        context("treasurer.near", 0);
        circle.advance_round(NOW + 2_000_000_000);
        complete_current_payout(&mut circle);
        assert!(circle.is_circle_completed());
        circle
    }

    #[test]
    #[should_panic(expected = "Public circles require proportional distribution after all rounds")]
    fn protected_public_payout_pauses_when_reserve_cannot_cover_shortfall() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("alice.near", CONTRIBUTION);
        circle.contribute();
        context_at("treasurer.near", 0, NOW + 1_000_000_000);
        let _ = circle.release_payout();
    }

    #[test]
    #[should_panic(expected = "Public circles require proportional distribution after all rounds")]
    fn public_circle_rejects_rotating_payout_even_with_full_protection() {
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
    #[should_panic(expected = "Public circles require proportional distribution after all rounds")]
    fn public_circle_rejects_rotating_payout_for_partial_shortfall() {
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
    #[should_panic(expected = "Public circles require proportional distribution after all rounds")]
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
    #[should_panic(expected = "Public circles require proportional distribution after all rounds")]
    fn public_circle_does_not_attempt_legacy_payout_after_a_missed_contribution() {
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
    #[should_panic(expected = "Public circles require proportional distribution after all rounds")]
    fn public_circle_does_not_spend_reserve_on_rotating_payout() {
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
    fn completed_circle_can_refund_unused_reserve_to_original_funder() {
        let mut circle = completed_circle_with_reserve_funder();
        assert_eq!(
            circle.get_reserve_share(account("sponsor.near")),
            U128(2 * CONTRIBUTION)
        );
        context("sponsor.near", 0);
        let _ = circle.refund_protection();
        assert_eq!(circle.get_reserve_share(account("sponsor.near")), U128(0));
        assert_eq!(circle.get_protection_balance(), U128(0));

        let callback_context = VMContextBuilder::new()
            .current_account_id(account("circle.near"))
            .predecessor_account_id(account("circle.near"))
            .block_timestamp(NOW + 2_000_000_000)
            .build();
        testing_env_with_promise_results(callback_context, PromiseResult::Successful(Vec::new()));
        circle.on_reserve_refund_complete(account("sponsor.near"), U128(2 * CONTRIBUTION));
        assert_eq!(circle.get_reserve_share(account("sponsor.near")), U128(0));
    }

    #[test]
    fn failed_reserve_refund_restores_funder_share_and_available_balance() {
        let mut circle = completed_circle_with_reserve_funder();
        context("sponsor.near", 0);
        let _ = circle.refund_protection();
        let callback_context = VMContextBuilder::new()
            .current_account_id(account("circle.near"))
            .predecessor_account_id(account("circle.near"))
            .block_timestamp(NOW + 2_000_000_000)
            .build();
        testing_env_with_promise_results(callback_context, PromiseResult::Failed);
        circle.on_reserve_refund_complete(account("sponsor.near"), U128(2 * CONTRIBUTION));
        assert_eq!(
            circle.get_reserve_share(account("sponsor.near")),
            U128(2 * CONTRIBUTION)
        );
        assert_eq!(circle.get_protection_balance(), U128(2 * CONTRIBUTION));
    }

    #[test]
    #[should_panic(expected = "Circle must be completed before reserve refunds")]
    fn reserve_refund_is_blocked_until_circle_completion() {
        let mut circle = sample_circle(CircleMode::ProtectedPublic);
        context("sponsor.near", CONTRIBUTION);
        circle.fund_protection();
        context("sponsor.near", 0);
        let _ = circle.refund_protection();
    }

    #[test]
    #[should_panic(expected = "Payout is already pending or complete")]
    fn payout_cannot_be_released_twice_while_transfer_is_pending() {
        let mut circle = sample_circle(CircleMode::Private);
        contribute_all_members(&mut circle);
        context("treasurer.near", 0);
        let _ = circle.release_payout();
        assert!(circle.is_payout_pending());
        let _ = circle.release_payout();
    }

    #[test]
    #[should_panic(expected = "A collateral release is pending")]
    fn reserve_refund_cannot_overlap_pending_guarantee_release() {
        let mut circle = completed_circle_with_guarantee_and_reserve_funder();
        context("anyone.near", 0);
        let _ = circle.release_guarantee(account("alice.near"));
        context("sponsor.near", 0);
        let _ = circle.refund_protection();
    }

    #[test]
    #[should_panic(expected = "A reserve refund is pending")]
    fn guarantee_release_cannot_overlap_pending_reserve_refund() {
        let mut circle = completed_circle_with_guarantee_and_reserve_funder();
        context("sponsor.near", 0);
        let _ = circle.refund_protection();
        context("anyone.near", 0);
        let _ = circle.release_guarantee(account("alice.near"));
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

    #[test]
    #[should_panic(expected = "Guarantee has expired")]
    fn expired_guarantee_cannot_cover_a_missed_contribution() {
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

        context_at("anyone.near", 0, NOW + 2_000_000_000);
        circle.claim_guarantee_for_missed_contribution(account("alice.near"));
    }

    #[test]
    #[should_panic(expected = "No payout is pending")]
    fn successful_payout_callback_cannot_be_replayed() {
        let mut circle = sample_circle(CircleMode::Private);
        contribute_all_members(&mut circle);
        context("treasurer.near", 0);
        let _ = circle.release_payout();

        let callback_context = VMContextBuilder::new()
            .current_account_id(account("circle.near"))
            .predecessor_account_id(account("circle.near"))
            .block_timestamp(NOW + 1_000_000_000)
            .build();
        testing_env_with_promise_results(callback_context, PromiseResult::Successful(Vec::new()));
        circle.on_payout_complete();
        assert!(circle.is_payout_complete());
        circle.on_payout_complete();
    }
}
