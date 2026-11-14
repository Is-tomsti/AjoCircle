use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{
    env, near_bindgen, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PromiseResult,
};

const MAX_MEMBERS_PER_CIRCLE: u32 = 100;
const MAX_PAGE_SIZE: u32 = 50;
const MAX_INVITATIONS_PER_CIRCLE: u32 = 250;
const MAX_EXPIRY_BATCH: u32 = 25;
const MAX_CLEANUP_BATCH: u32 = 25;
const MAX_STORAGE_PAYER_PER_CIRCLE: u32 = 1024;
const MAX_DEFAULT_SCAN_BATCH: u32 = 25;
const PUBLIC_DEFAULT_VOTE_WINDOW_NS: u64 = 86_400_000_000_000;
const PUBLIC_DEFAULT_PENALTY_BPS: u128 = 500;
const DISTRIBUTION_FEE_BPS: u128 = 50;
const BASIS_POINT_DENOMINATOR: u128 = 10_000;
const USDC_ENTRY_FEE_BASE_UNITS: u128 = 250_000;
const STORAGE_REFUND_CALLBACK_GAS_TGAS: u64 = 10;
const USDC_STORAGE_CHECK_GAS_TGAS: u64 = 15;
const USDC_STORAGE_CALLBACK_GAS_TGAS: u64 = 100;
const USDC_FT_TRANSFER_GAS_TGAS: u64 = 30;
const PAYOUT_CALLBACK_GAS_TGAS: u64 = 35;
const MAX_PAYOUT_RETRIES: u32 = 3;
const SCHEMA_VERSION: u32 = 1;
const USDC_TOKEN_ID: &str = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const USDC_DECIMALS: u8 = 6;

fn encode_receipt_id(value: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for byte in value {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

type CircleId = u64;
type CircleIndexStorageRelease = (u64, Option<(CircleId, u64)>, Option<(CircleId, u64)>);

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Copy,
    Debug,
    Deserialize,
    PartialEq,
    Serialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum CircleMode {
    Public,
    Private,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Copy,
    Debug,
    Deserialize,
    PartialEq,
    Serialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum CircleStatus {
    RegistrationOpen,
    RegistrationClosed,
    Active,
    Expiring,
    Cancelled,
    Closing,
    Closed,
    SettlementReady,
    Completed,
    RefundingStorage,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Copy,
    Debug,
    Deserialize,
    PartialEq,
    Serialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum InvitationStatus {
    Pending,
    Accepted,
    Revoked,
    Expired,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Copy, Debug, PartialEq)]
enum CleanupStage {
    Invitations,
    Contributions,
    MissedAndDefaults,
    Votes,
    ExitsAndTotals,
    EntryFees,
    Members,
    Rounds,
    Finalize,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct Circle {
    id: CircleId,
    creator: AccountId,
    mode: CircleMode,
    status: CircleStatus,
    minimum_members: u32,
    maximum_members: u32,
    member_count: u32,
    pending_invitation_count: u32,
    invitation_count: u32,
    expiry_cursor: u32,
    cleanup_invitation_cursor: u32,
    cleanup_member_cursor: u32,
    cleanup_round_cursor: u32,
    cleanup_vote_cursor: u32,
    cleanup_entry_fee_cursor: u32,
    cleanup_stage: CleanupStage,
    removal_vote_count: u32,
    contribution_liability_usdc_base_units: u128,
    original_round_count: u32,
    rounds_storage_payer: Option<AccountId>,
    contribution_amount_usdc_base_units: u128,
    entry_fee_usdc_base_units: u128,
    entry_fee_total_usdc_base_units: u128,
    entry_fee_paid_count: u32,
    entry_fee_slot_count: u32,
    entry_fee_refund_cursor: u32,
    entry_fee_refund_complete: bool,
    current_round: u32,
    rounds: Vec<RoundRecord>,
    public_distribution_started: bool,
    public_distribution_cursor: u32,
    public_distribution_total_usdc_base_units: u128,
    public_distribution_remaining_usdc_base_units: u128,
    payout_next_nonce: u64,
    payout_in_flight: Option<PayoutAttempt>,
    payout_failed: Option<PayoutAttempt>,
    registration_deadline_ns: u64,
    created_at_ns: u64,
    storage_deposit_yocto: u128,
    storage_locked_yocto: u128,
    storage_payer_count: u32,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Copy,
    Debug,
    Deserialize,
    PartialEq,
    Serialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum RoundStatus {
    Scheduled,
    Open,
    ContributionsComplete,
    DeadlinePassed,
    PayoutInFlight,
    PaidOut,
    CycleAccumulated,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct RoundRecord {
    deadline_ns: u64,
    status: RoundStatus,
    required_contribution_count: u32,
    contribution_count: u32,
    total_contributed_usdc_base_units: u128,
    missed_scan_cursor: u32,
    missed_scan_complete: bool,
    missed_count: u32,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Copy,
    Debug,
    Deserialize,
    PartialEq,
    Serialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum DefaultCaseStatus {
    PendingVote,
    RemovalRejected,
    RemovalApproved,
    VoteWindowExpired,
    VoluntaryExitRequested,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct MissedContributionRecord {
    storage_payer: AccountId,
    expected_amount_usdc_base_units: u128,
    deadline_ns: u64,
    recorded_at_ns: u64,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct DefaultCaseRecord {
    storage_payer: AccountId,
    status: DefaultCaseStatus,
    vote_deadline_ns: u64,
    eligible_voter_count: u32,
    approve_count: u32,
    reject_count: u32,
    recorded_at_ns: u64,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Copy,
    Debug,
    Deserialize,
    PartialEq,
    Serialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    Voluntary,
    PublicDefaultRemoval,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Copy,
    Debug,
    Deserialize,
    PartialEq,
    Serialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ExitSettlementStatus {
    PendingSettlement,
    Settled,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Copy,
    Debug,
    Deserialize,
    PartialEq,
    Serialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum PayoutKind {
    PrivateRound,
    PublicDistribution,
    EntryFeeRefund,
    // Appended to preserve the existing Borsh discriminants for deployed variants.
    PublicDefaultExit,
    // Appended so existing payout-attempt encodings retain their discriminants.
    MissedContributionRefund,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct PayoutAttempt {
    nonce: u64,
    retry_count: u32,
    kind: PayoutKind,
    round_index: u32,
    allocation_index: u32,
    recipient: AccountId,
    gross_amount_usdc_base_units: u128,
    penalty_amount_usdc_base_units: u128,
    distribution_fee_usdc_base_units: u128,
    transfer_amount_usdc_base_units: u128,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct EntryFeeRecord {
    amount_usdc_base_units: u128,
    receipt_id: [u8; 32],
    paid_at_ns: u64,
    // Zero means not refunded. Fixed-size sentinel is preserved for Segment 3 refunds.
    refund_at_ns: u64,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct MemberExitRecord {
    storage_payer: AccountId,
    reason: ExitReason,
    status: ExitSettlementStatus,
    requested_at_ns: u64,
    source_round: u32,
    gross_claim_usdc_base_units: u128,
    penalty_basis_usdc_base_units: u128,
    penalty_bps: u16,
    penalty_usdc_base_units: u128,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct ContributionRecord {
    amount_usdc_base_units: u128,
    receipt_id: [u8; 32],
    contributed_at_ns: u64,
    block_height: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UsdcContributionMessage {
    version: u8,
    action: String,
    circle_id: U64,
    round_index: u32,
}

/// NEP-145 response from the configured Circle USDC token contract.
/// A non-null balance proves registration; no automatic account registration is performed.
#[derive(Deserialize)]
struct TokenStorageBalance {
    total: U128,
    available: U128,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct MemberRecord {
    joined_at_ns: u64,
}

/// One payer's storage liability for one circle. The available amount is always derived:
/// paid - storage_locked - pending_refund - already_refunded.
#[derive(BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct StorageDepositRecord {
    total_paid_yocto: u128,
    storage_locked_yocto: u128,
    pending_refund_yocto: u128,
    refunded_yocto: u128,
    storage_bytes_funded: u64,
    storage_bytes_released: u64,
    shared_index_locked_yocto: u128,
    next_refund_nonce: u64,
    pending_refund_nonce: u64,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Copy)]
struct AccountCircleCountRecord {
    count: u32,
    funding_circle_id: CircleId,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct RemovalVoteKey {
    round_index: u32,
    target: AccountId,
    voter: AccountId,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Copy, Debug, PartialEq)]
enum PendingStorageRefundStatus {
    Idle,
    Pending,
    Failed,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct PendingStorageRefund {
    payer_bytes: [u8; 64],
    payer_len: u8,
    amount_yocto: u128,
    nonce: u64,
    status: PendingStorageRefundStatus,
    kind: u8,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct ClosedCircleTombstone {
    id: CircleId,
    creator: AccountId,
    mode: CircleMode,
    status: CircleStatus,
    original_member_count: u32,
    original_round_count: u32,
    storage_deposit_yocto: u128,
    entry_fee_total_usdc_base_units: u128,
    created_at_ns: u64,
    closed_at_ns: u64,
    storage_payer_count: u32,
    refund_cursor: u32,
    deferred_refund_count: u32,
    refund_pass: u32,
    storage_locked_yocto: u128,
    total_storage_refunded_yocto: u128,
    next_refund_nonce: u64,
    pending_refund: PendingStorageRefund,
}

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Circles,
    Members,
    MemberOrder,
    MemberOrderPayers,
    MemberCircleIndex,
    MemberCircleIndexRowFunders,
    MemberCirclePositions,
    AccountCircleCounts,
    RemovalVoteOrder,
    ClosedCircleTombstones,
    Invitations,
    InvitationOrder,
    StorageDeposits,
    StorageDepositPayerOrder,
    Contributions,
    MissedContributions,
    DefaultCases,
    RemovalVotes,
    EverDefaulted,
    EverDefaultedPayers,
    MemberExits,
    EntryFeePayments,
    EntryFeePayerOrder,
    MemberContributionTotals,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct CircleSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    #[schemars(with = "String")]
    pub creator: AccountId,
    pub mode: CircleMode,
    pub status: CircleStatus,
    pub minimum_members: u32,
    pub maximum_members: u32,
    pub member_count: u32,
    pub pending_invitation_count: u32,
    pub invitation_expiry_cursor: u32,
    pub cleanup_invitation_cursor: u32,
    pub cleanup_member_cursor: u32,
    #[schemars(with = "String")]
    pub contribution_amount_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub entry_fee_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub entry_fee_total_usdc_base_units: U128,
    pub entry_fee_paid_count: u32,
    pub entry_fee_slot_count: u32,
    pub entry_fee_refund_cursor: u32,
    pub entry_fee_refund_complete: bool,
    pub current_round: u32,
    pub round_count: u32,
    #[schemars(with = "Option<String>")]
    pub current_round_deadline_ns: Option<U64>,
    pub public_distribution_started: bool,
    pub public_distribution_cursor: u32,
    #[schemars(with = "String")]
    pub public_distribution_total_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub public_distribution_remaining_usdc_base_units: U128,
    pub payout_in_flight: bool,
    pub payout_failed: bool,
    #[schemars(with = "String")]
    pub registration_deadline_ns: U64,
    #[schemars(with = "String")]
    pub created_at_ns: U64,
    #[schemars(with = "String")]
    pub storage_deposit_yocto: U128,
    #[schemars(with = "String")]
    pub storage_locked_yocto: U128,
    pub storage_payer_count: u32,
    #[schemars(with = "Option<String>")]
    pub closed_at_ns: Option<U64>,
    #[schemars(with = "String")]
    pub total_storage_refunded_yocto: U128,
    pub storage_refund_cursor: u32,
    pub storage_refund_deferred_count: u32,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct CleanupCandidateSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    pub status: CircleStatus,
    pub entry_fee_refund_complete: bool,
    pub cleanup_in_progress: bool,
    pub storage_refund_pending: bool,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct CircleCleanupStateSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    pub status: CircleStatus,
    pub phase: String,
    pub cleanup_invitation_cursor: u32,
    pub cleanup_round_cursor: u32,
    pub cleanup_member_cursor: u32,
    pub cleanup_vote_cursor: u32,
    pub cleanup_entry_fee_cursor: u32,
    pub removal_vote_count: u32,
    pub storage_payer_count: u32,
    pub refund_cursor: u32,
    pub deferred_refund_count: u32,
    pub pending_refund: bool,
    pub pending_refund_failed: bool,
    #[schemars(with = "String")]
    pub pending_refund_amount_yocto: U128,
    #[schemars(with = "String")]
    pub pending_refund_nonce: U64,
    #[schemars(with = "String")]
    pub contribution_liability_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub total_storage_refunded_yocto: U128,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct MissedContributionRefundClaimSummary {
    #[schemars(with = "String")]
    pub member: AccountId,
    #[schemars(with = "String")]
    pub amount_usdc_base_units: U128,
    pub already_settled: bool,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct MissedContributionRefundStateSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    pub status: CircleStatus,
    pub mode: CircleMode,
    pub current_round: u32,
    #[schemars(with = "Option<String>")]
    pub deadline_ns: Option<U64>,
    #[schemars(with = "Option<String>")]
    pub cancellation_available_at_ns: Option<U64>,
    pub missed_scan_complete: bool,
    pub missed_count: u32,
    pub cancellation_eligible: bool,
    pub refund_cursor: u32,
    #[schemars(with = "String")]
    pub contribution_liability_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub entry_fee_liability_usdc_base_units: U128,
    pub entry_fee_refund_complete: bool,
    pub payout_in_flight: bool,
    pub payout_failed: bool,
    pub claims: Vec<MissedContributionRefundClaimSummary>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct MemberSummary {
    #[schemars(with = "String")]
    pub account_id: AccountId,
    #[schemars(with = "String")]
    pub joined_at_ns: U64,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct RoundSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    pub round_index: u32,
    #[schemars(with = "String")]
    pub deadline_ns: U64,
    pub status: RoundStatus,
    pub contribution_count: u32,
    pub member_count: u32,
    pub required_contribution_count: u32,
    pub remaining_contributions: u32,
    #[schemars(with = "String")]
    pub contribution_amount_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub total_contributed_usdc_base_units: U128,
    pub missed_count: u32,
    pub missed_scan_cursor: u32,
    pub missed_scan_complete: bool,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct ContributionSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    pub round_index: u32,
    #[schemars(with = "String")]
    pub member: AccountId,
    #[schemars(with = "String")]
    pub amount_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub receipt_id: String,
    #[schemars(with = "String")]
    pub contributed_at_ns: U64,
    #[schemars(with = "String")]
    pub block_height: U64,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct DefaultScanSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    pub round_index: u32,
    pub processed_count: u32,
    pub missed_count: u32,
    pub next_cursor: u32,
    pub complete: bool,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct MissedContributionSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    pub round_index: u32,
    #[schemars(with = "String")]
    pub member: AccountId,
    #[schemars(with = "String")]
    pub expected_amount_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub deadline_ns: U64,
    #[schemars(with = "String")]
    pub recorded_at_ns: U64,
    pub public_default_case: bool,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct DefaultCaseSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    pub round_index: u32,
    #[schemars(with = "String")]
    pub member: AccountId,
    pub status: DefaultCaseStatus,
    #[schemars(with = "String")]
    pub vote_deadline_ns: U64,
    pub eligible_voter_count: u32,
    pub approve_count: u32,
    pub reject_count: u32,
    #[schemars(with = "String")]
    pub recorded_at_ns: U64,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct MemberExitSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    #[schemars(with = "String")]
    pub member: AccountId,
    pub reason: ExitReason,
    pub status: ExitSettlementStatus,
    #[schemars(with = "String")]
    pub requested_at_ns: U64,
    pub source_round: u32,
    #[schemars(with = "String")]
    pub gross_claim_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub penalty_basis_usdc_base_units: U128,
    pub penalty_bps: u16,
    #[schemars(with = "String")]
    pub penalty_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub net_claim_after_penalty_usdc_base_units: U128,
}

#[derive(Debug, PartialEq, Serialize, schemars::JsonSchema)]
pub struct StorageDepositSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    #[schemars(with = "String")]
    pub payer: AccountId,
    #[schemars(with = "String")]
    pub total_paid_yocto: U128,
    #[schemars(with = "String")]
    pub storage_locked_yocto: U128,
    #[schemars(with = "String")]
    pub pending_refund_yocto: U128,
    #[schemars(with = "String")]
    pub refunded_yocto: U128,
    #[schemars(with = "String")]
    pub available_refund_yocto: U128,
    #[schemars(with = "String")]
    pub storage_bytes_funded: U64,
    #[schemars(with = "String")]
    pub storage_bytes_released: U64,
    #[schemars(with = "String")]
    pub next_refund_nonce: U64,
    #[schemars(with = "String")]
    pub pending_refund_nonce: U64,
    #[schemars(with = "String")]
    pub shared_index_locked_yocto: U128,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct ContractConfig {
    #[schemars(with = "String")]
    pub owner_id: AccountId,
    #[schemars(with = "String")]
    pub usdc_token_id: AccountId,
    pub usdc_symbol: String,
    pub usdc_decimals: u8,
    pub schema_version: u32,
    #[schemars(with = "String")]
    pub next_circle_id: U64,
    pub maximum_members_per_circle: u32,
    pub maximum_page_size: u32,
    #[schemars(with = "String")]
    pub storage_refund_liability_yocto: U128,
    #[schemars(with = "String")]
    pub contribution_liability_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub penalty_liability_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub entry_fee_usdc_base_units: U128,
    pub distribution_fee_bps: u16,
    #[schemars(with = "String")]
    pub entry_fee_liability_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub distribution_fee_liability_usdc_base_units: U128,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct EntryFeeSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    #[schemars(with = "String")]
    pub member: AccountId,
    #[schemars(with = "String")]
    pub amount_usdc_base_units: U128,
    pub receipt_id: String,
    #[schemars(with = "String")]
    pub paid_at_ns: U64,
    pub refunded: bool,
    #[schemars(with = "Option<String>")]
    pub refunded_at_ns: Option<U64>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct PayoutAttemptSummary {
    #[schemars(with = "String")]
    pub nonce: U64,
    pub retry_count: u32,
    pub kind: PayoutKind,
    pub round_index: u32,
    pub allocation_index: u32,
    #[schemars(with = "String")]
    pub token_id: AccountId,
    pub attempt_fingerprint: String,
    #[schemars(with = "String")]
    pub recipient: AccountId,
    #[schemars(with = "String")]
    pub gross_amount_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub penalty_amount_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub distribution_fee_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub transfer_amount_usdc_base_units: U128,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct CirclePayoutStateSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    #[schemars(with = "String")]
    pub next_nonce: U64,
    pub in_flight: Option<PayoutAttemptSummary>,
    pub failed: Option<PayoutAttemptSummary>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct EntryFeePayerSummary {
    #[schemars(with = "String")]
    pub circle_id: U64,
    pub index: u32,
    #[schemars(with = "String")]
    pub member: AccountId,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct ContractBackingSummary {
    #[schemars(with = "String")]
    pub account_balance_yocto: U128,
    #[schemars(with = "String")]
    pub storage_usage_bytes: U64,
    #[schemars(with = "String")]
    pub storage_byte_cost_yocto: U128,
    #[schemars(with = "String")]
    pub storage_stake_yocto: U128,
    #[schemars(with = "String")]
    pub liquid_after_storage_yocto: U128,
    #[schemars(with = "String")]
    pub storage_refund_liability_yocto: U128,
    #[schemars(with = "String")]
    pub contribution_liability_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub penalty_liability_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub entry_fee_liability_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub distribution_fee_liability_usdc_base_units: U128,
    #[schemars(with = "String")]
    pub protected_liabilities_yocto: U128,
    #[schemars(with = "String")]
    pub backing_surplus_yocto: U128,
    pub fully_backed: bool,
}

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
pub struct CentralCircleContract {
    owner_id: AccountId,
    usdc_token_id: AccountId,
    next_circle_id: CircleId,
    circles: LookupMap<CircleId, Circle>,
    members: LookupMap<(CircleId, AccountId), MemberRecord>,
    member_order: LookupMap<(CircleId, u32), AccountId>,
    member_order_payers: LookupMap<(CircleId, u32), AccountId>,
    member_circle_index: LookupMap<(AccountId, u32), CircleId>,
    member_circle_index_row_funders: LookupMap<(AccountId, u32), CircleId>,
    member_circle_positions: LookupMap<(CircleId, AccountId), u32>,
    account_circle_counts: LookupMap<AccountId, AccountCircleCountRecord>,
    removal_vote_order: LookupMap<(CircleId, u32), RemovalVoteKey>,
    closed_circle_tombstones: LookupMap<CircleId, ClosedCircleTombstone>,
    invitations: LookupMap<(CircleId, AccountId), InvitationStatus>,
    invitation_order: LookupMap<(CircleId, u32), AccountId>,
    storage_deposits: LookupMap<(CircleId, AccountId), StorageDepositRecord>,
    storage_deposit_payer_order: LookupMap<(CircleId, u32), AccountId>,
    contributions: LookupMap<(CircleId, u32, AccountId), ContributionRecord>,
    member_contribution_totals: LookupMap<(CircleId, AccountId), u128>,
    missed_contributions: LookupMap<(CircleId, u32, AccountId), MissedContributionRecord>,
    default_cases: LookupMap<(CircleId, u32, AccountId), DefaultCaseRecord>,
    removal_votes: LookupMap<(CircleId, u32, AccountId, AccountId), bool>,
    ever_defaulted: LookupMap<(CircleId, AccountId), bool>,
    ever_defaulted_payers: LookupMap<(CircleId, AccountId), AccountId>,
    member_exits: LookupMap<(CircleId, AccountId), MemberExitRecord>,
    entry_fee_payments: LookupMap<(CircleId, AccountId), EntryFeeRecord>,
    entry_fee_payer_order: LookupMap<(CircleId, u32), AccountId>,
    storage_refund_liability_yocto: u128,
    contribution_liability_usdc_base_units: u128,
    penalty_liability_usdc_base_units: u128,
    entry_fee_liability_usdc_base_units: u128,
    distribution_fee_liability_usdc_base_units: u128,
}

#[near_bindgen]
impl CentralCircleContract {
    fn assert_platform_sponsored(&self) {
        assert_eq!(
            env::signer_account_id(),
            self.owner_id,
            "AjoCircle platform sponsorship is required for NEAR gas"
        );
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            0,
            "AjoCircle sponsored actions must not require user-attached NEAR"
        );
    }

    fn platform_storage_payer(&self) -> AccountId {
        self.owner_id.clone()
    }

    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        assert!(!env::state_exists(), "Contract is already initialized");
        Self {
            owner_id,
            usdc_token_id: USDC_TOKEN_ID
                .parse()
                .expect("Pinned Circle USDC Testnet account ID is valid"),
            next_circle_id: 1,
            circles: LookupMap::new(StorageKey::Circles),
            members: LookupMap::new(StorageKey::Members),
            member_order: LookupMap::new(StorageKey::MemberOrder),
            member_order_payers: LookupMap::new(StorageKey::MemberOrderPayers),
            member_circle_index: LookupMap::new(StorageKey::MemberCircleIndex),
            member_circle_index_row_funders: LookupMap::new(
                StorageKey::MemberCircleIndexRowFunders,
            ),
            member_circle_positions: LookupMap::new(StorageKey::MemberCirclePositions),
            account_circle_counts: LookupMap::new(StorageKey::AccountCircleCounts),
            removal_vote_order: LookupMap::new(StorageKey::RemovalVoteOrder),
            closed_circle_tombstones: LookupMap::new(StorageKey::ClosedCircleTombstones),
            invitations: LookupMap::new(StorageKey::Invitations),
            invitation_order: LookupMap::new(StorageKey::InvitationOrder),
            storage_deposits: LookupMap::new(StorageKey::StorageDeposits),
            storage_deposit_payer_order: LookupMap::new(StorageKey::StorageDepositPayerOrder),
            contributions: LookupMap::new(StorageKey::Contributions),
            member_contribution_totals: LookupMap::new(StorageKey::MemberContributionTotals),
            missed_contributions: LookupMap::new(StorageKey::MissedContributions),
            default_cases: LookupMap::new(StorageKey::DefaultCases),
            removal_votes: LookupMap::new(StorageKey::RemovalVotes),
            ever_defaulted: LookupMap::new(StorageKey::EverDefaulted),
            ever_defaulted_payers: LookupMap::new(StorageKey::EverDefaultedPayers),
            member_exits: LookupMap::new(StorageKey::MemberExits),
            entry_fee_payments: LookupMap::new(StorageKey::EntryFeePayments),
            entry_fee_payer_order: LookupMap::new(StorageKey::EntryFeePayerOrder),
            storage_refund_liability_yocto: 0,
            contribution_liability_usdc_base_units: 0,
            penalty_liability_usdc_base_units: 0,
            entry_fee_liability_usdc_base_units: 0,
            distribution_fee_liability_usdc_base_units: 0,
        }
    }

    /// Creates one logical circle record inside this central contract. The creator occupies seat one.
    /// AjoCircle's pre-funded NEAR balance covers measured storage; the creator attaches no NEAR.
    pub fn create_circle(
        &mut self,
        mode: CircleMode,
        minimum_members: u32,
        maximum_members: u32,
        contribution_amount_usdc_base_units: U128,
        registration_deadline_ns: U64,
    ) -> U64 {
        self.assert_platform_sponsored();
        let creator = env::predecessor_account_id();
        let now = env::block_timestamp();

        assert!(
            minimum_members >= 2,
            "A circle must contain at least two members"
        );
        assert!(
            maximum_members >= minimum_members,
            "Maximum members cannot be below minimum members"
        );
        assert!(
            maximum_members <= MAX_MEMBERS_PER_CIRCLE,
            "Circle capacity exceeds the current safe limit"
        );
        assert!(
            contribution_amount_usdc_base_units.0 > 0,
            "Contribution amount must be greater than zero"
        );
        assert!(
            registration_deadline_ns.0 > now,
            "Registration deadline must be in the future"
        );

        let id = self.next_circle_id;
        let next_id = id.checked_add(1).expect("Circle ID space exhausted");
        let before_storage = env::storage_usage();

        let mut circle = Circle {
            id,
            creator: creator.clone(),
            mode,
            status: CircleStatus::RegistrationOpen,
            minimum_members,
            maximum_members,
            member_count: 0,
            pending_invitation_count: 0,
            invitation_count: 0,
            expiry_cursor: 0,
            cleanup_invitation_cursor: 0,
            cleanup_member_cursor: 0,
            cleanup_round_cursor: 0,
            cleanup_vote_cursor: 0,
            cleanup_entry_fee_cursor: 0,
            cleanup_stage: CleanupStage::Invitations,
            removal_vote_count: 0,
            contribution_liability_usdc_base_units: 0,
            original_round_count: 0,
            rounds_storage_payer: None,
            contribution_amount_usdc_base_units: contribution_amount_usdc_base_units.0,
            entry_fee_usdc_base_units: Self::configured_entry_fee_usdc_base_units(),
            entry_fee_total_usdc_base_units: 0,
            entry_fee_paid_count: 0,
            entry_fee_slot_count: 0,
            entry_fee_refund_cursor: 0,
            entry_fee_refund_complete: false,
            current_round: 0,
            rounds: Vec::new(),
            public_distribution_started: false,
            public_distribution_cursor: 0,
            public_distribution_total_usdc_base_units: 0,
            public_distribution_remaining_usdc_base_units: 0,
            payout_next_nonce: 0,
            payout_in_flight: None,
            payout_failed: None,
            registration_deadline_ns: registration_deadline_ns.0,
            created_at_ns: now,
            storage_deposit_yocto: 0,
            storage_locked_yocto: 0,
            storage_payer_count: 0,
        };
        let shared_index_bytes = self.add_member(&mut circle, creator.clone());
        self.prepare_platform_storage_sponsor(&mut circle);
        self.circles.insert(&id, &circle);
        self.finish_platform_storage_growth(&mut circle, before_storage, shared_index_bytes);
        self.circles.insert(&id, &circle);
        self.next_circle_id = next_id;

        Self::emit(
            "circle_created",
            near_sdk::serde_json::json!({
                "circle_id": id.to_string(),
                "creator": creator,
                "mode": mode,
                "maximum_members": maximum_members,
                "member_count": circle.member_count,
                "storage_deposit_yocto": circle.storage_deposit_yocto.to_string(),
                "storage_locked_yocto": circle.storage_locked_yocto.to_string(),
                "entry_fee_usdc_base_units": circle.entry_fee_usdc_base_units.to_string(),
                "entry_fee_paid_usdc_base_units": "0"
            }),
        );

        U64(id)
    }

    /// Public registration is wallet-bound. The member's USDC entry fee is separate;
    /// AjoCircle sponsors all NEAR gas and incremental persistent storage.
    pub fn join_public_circle(&mut self, circle_id: U64) {
        self.assert_platform_sponsored();
        let account = env::predecessor_account_id();
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");

        assert_eq!(circle.mode, CircleMode::Public, "Circle is not public");
        assert_eq!(
            circle.status,
            CircleStatus::RegistrationOpen,
            "Circle registration is closed"
        );
        assert!(
            env::block_timestamp() < circle.registration_deadline_ns,
            "Registration deadline has passed"
        );
        assert!(
            circle.member_count + circle.pending_invitation_count < circle.maximum_members,
            "Circle has reached capacity"
        );
        let before_storage = env::storage_usage();
        let shared_index_bytes = self.add_member(&mut circle, account.clone());
        self.prepare_platform_storage_sponsor(&mut circle);
        self.circles.insert(&circle_id.0, &circle);
        self.finish_platform_storage_growth(&mut circle, before_storage, shared_index_bytes);
        self.circles.insert(&circle_id.0, &circle);

        Self::emit(
            "public_member_joined",
            near_sdk::serde_json::json!({
                "circle_id": circle_id.0.to_string(),
                "member": account,
                "member_count": circle.member_count,
                "entry_fee_paid_usdc_base_units": "0"
            }),
        );
    }

    /// The creator authorizes the invitation; AjoCircle sponsors invitation and membership storage.
    pub fn invite_private_member(&mut self, circle_id: U64, invitee: AccountId) {
        self.assert_platform_sponsored();
        let caller = env::predecessor_account_id();
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");

        assert_eq!(circle.mode, CircleMode::Private, "Circle is not private");
        assert_eq!(
            circle.creator, caller,
            "Only the creator may issue invitations"
        );
        assert_eq!(
            circle.status,
            CircleStatus::RegistrationOpen,
            "Circle registration is closed"
        );
        assert!(
            env::block_timestamp() < circle.registration_deadline_ns,
            "Registration deadline has passed"
        );
        assert_ne!(invitee, caller, "Creator already occupies a member seat");
        assert!(
            self.members.get(&(circle_id.0, invitee.clone())).is_none(),
            "Account is already a circle member"
        );
        let previous_invitation = self.invitations.get(&(circle_id.0, invitee.clone()));
        assert!(
            previous_invitation
                .map(|status| status == InvitationStatus::Revoked
                    || status == InvitationStatus::Expired)
                .unwrap_or(true),
            "An active invitation already exists for this account"
        );
        assert!(
            circle.member_count + circle.pending_invitation_count < circle.maximum_members,
            "Circle has no unreserved member seats"
        );

        let before_storage = env::storage_usage();
        self.prepare_platform_storage_sponsor(&mut circle);
        if previous_invitation.is_none() {
            assert!(
                circle.invitation_count < MAX_INVITATIONS_PER_CIRCLE,
                "Circle has reached its historical invitation limit"
            );
            self.invitation_order
                .insert(&(circle_id.0, circle.invitation_count), &invitee);
            circle.invitation_count = circle
                .invitation_count
                .checked_add(1)
                .expect("Invitation count overflow");
        }
        self.invitations
            .insert(&(circle_id.0, invitee.clone()), &InvitationStatus::Pending);
        circle.pending_invitation_count = circle
            .pending_invitation_count
            .checked_add(1)
            .expect("Pending invitation count overflow");

        if circle.member_count + circle.pending_invitation_count >= circle.maximum_members {
            circle.status = CircleStatus::RegistrationClosed;
        }
        self.circles.insert(&circle_id.0, &circle);
        self.finish_platform_storage_growth(&mut circle, before_storage, 0);
        self.circles.insert(&circle_id.0, &circle);

        Self::emit(
            "private_member_invited",
            near_sdk::serde_json::json!({
                "circle_id": circle_id.0.to_string(),
                "inviter": caller,
                "invitee": invitee,
                "pending_invitation_count": circle.pending_invitation_count
            }),
        );
    }

    /// The invited wallet accepts as predecessor; AjoCircle sponsors NEAR gas and membership storage.
    /// Any applicable USDC entry fee remains a separate USDC transfer.
    pub fn accept_private_invitation(&mut self, circle_id: U64) {
        self.assert_platform_sponsored();
        let invitee = env::predecessor_account_id();
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");

        assert_eq!(circle.mode, CircleMode::Private, "Circle is not private");
        assert!(
            circle.status == CircleStatus::RegistrationOpen
                || circle.status == CircleStatus::RegistrationClosed,
            "Circle is not accepting private invitees"
        );
        assert!(
            env::block_timestamp() < circle.registration_deadline_ns,
            "Invitation has expired"
        );
        assert_eq!(
            self.invitations.get(&(circle_id.0, invitee.clone())),
            Some(InvitationStatus::Pending),
            "No pending invitation exists for this wallet"
        );
        assert!(
            circle.member_count < circle.maximum_members,
            "Circle has reached capacity"
        );
        let before_storage = env::storage_usage();
        self.prepare_platform_storage_sponsor(&mut circle);
        self.invitations
            .insert(&(circle_id.0, invitee.clone()), &InvitationStatus::Accepted);
        circle.pending_invitation_count = circle
            .pending_invitation_count
            .checked_sub(1)
            .expect("Pending invitation count underflow");
        let shared_index_bytes = self.add_member(&mut circle, invitee.clone());
        self.circles.insert(&circle_id.0, &circle);
        self.finish_platform_storage_growth(&mut circle, before_storage, shared_index_bytes);
        self.circles.insert(&circle_id.0, &circle);

        Self::emit(
            "private_invitation_accepted",
            near_sdk::serde_json::json!({
                "circle_id": circle_id.0.to_string(),
                "member": invitee,
                "member_count": circle.member_count,
                "entry_fee_paid_usdc_base_units": "0"
            }),
        );
    }

    /// The creator may revoke an outstanding invitation before the circle starts.
    pub fn revoke_private_invitation(&mut self, circle_id: U64, invitee: AccountId) {
        self.assert_platform_sponsored();
        let caller = env::predecessor_account_id();
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        assert_eq!(circle.mode, CircleMode::Private, "Circle is not private");
        assert_eq!(
            circle.creator, caller,
            "Only the creator may revoke invitations"
        );
        assert!(
            circle.status != CircleStatus::Active && circle.status != CircleStatus::Cancelled,
            "Circle no longer accepts invitation changes"
        );
        assert_eq!(
            self.invitations.get(&(circle_id.0, invitee.clone())),
            Some(InvitationStatus::Pending),
            "No pending invitation exists for this account"
        );

        self.invitations
            .insert(&(circle_id.0, invitee.clone()), &InvitationStatus::Revoked);
        circle.pending_invitation_count = circle
            .pending_invitation_count
            .checked_sub(1)
            .expect("Pending invitation count underflow");
        if circle.pending_invitation_count == 0
            && circle.member_count < circle.maximum_members
            && env::block_timestamp() < circle.registration_deadline_ns
        {
            circle.status = CircleStatus::RegistrationOpen;
        }
        self.circles.insert(&circle_id.0, &circle);

        Self::emit(
            "private_member_invitation_revoked",
            near_sdk::serde_json::json!({
                "circle_id": circle_id.0.to_string(),
                "creator": caller,
                "invitee": invitee
            }),
        );
    }

    /// Anyone may close registration after the deadline or when every seat is reserved/filled.
    pub fn close_registration(&mut self, circle_id: U64) {
        self.assert_platform_sponsored();
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        assert_eq!(
            circle.status,
            CircleStatus::RegistrationOpen,
            "Circle registration is not open"
        );
        assert!(
            env::block_timestamp() >= circle.registration_deadline_ns
                || circle.member_count + circle.pending_invitation_count >= circle.maximum_members,
            "Registration cannot close before its deadline unless capacity is reached"
        );
        circle.status = CircleStatus::RegistrationClosed;
        self.circles.insert(&circle_id.0, &circle);

        Self::emit(
            "circle_registration_closed",
            near_sdk::serde_json::json!({
                "circle_id": circle_id.0.to_string(),
                "member_count": circle.member_count,
                "pending_invitation_count": circle.pending_invitation_count
            }),
        );
    }

    /// The creator may cancel a circle before it starts. Existing records remain as an audit
    /// tombstone and their measured storage stake remains locked; only payer-specific surplus is
    /// withdrawable. Financially active circles cannot be cancelled by this entrypoint.
    pub fn cancel_unstarted_circle(&mut self, circle_id: U64) {
        self.assert_platform_sponsored();
        let caller = env::predecessor_account_id();
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        assert_eq!(
            circle.creator, caller,
            "Only the creator may cancel the circle"
        );
        assert!(
            circle.status == CircleStatus::RegistrationOpen
                || circle.status == CircleStatus::RegistrationClosed,
            "Only an unstarted circle can be cancelled"
        );
        assert_eq!(
            circle.pending_invitation_count, 0,
            "Pending invitations must be revoked before cancellation"
        );
        circle.status = CircleStatus::Cancelled;
        self.circles.insert(&circle_id.0, &circle);

        Self::emit(
            "unstarted_circle_cancelled",
            near_sdk::serde_json::json!({
                "circle_id": circle_id.0.to_string(),
                "creator": caller,
                "member_count": circle.member_count
            }),
        );
    }

    /// Starts or continues bounded expiry of an under-minimum unstarted circle.
    /// Each call processes at most MAX_EXPIRY_BATCH historical invitation records.
    /// The invitation ledger itself is capped, so one circle cannot create an unbounded cleanup job.
    pub fn expire_unstarted_circle(&mut self, circle_id: U64) {
        self.assert_platform_sponsored();
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");

        if circle.status == CircleStatus::RegistrationOpen
            || circle.status == CircleStatus::RegistrationClosed
        {
            assert!(
                env::block_timestamp() >= circle.registration_deadline_ns,
                "Registration deadline has not passed"
            );
            assert!(
                circle.member_count < circle.minimum_members,
                "Circle met its minimum member count"
            );
            circle.status = CircleStatus::Expiring;
        } else {
            assert_eq!(
                circle.status,
                CircleStatus::Expiring,
                "Circle is not eligible for expiry"
            );
        }

        let start = circle.expiry_cursor;
        let end = start
            .saturating_add(MAX_EXPIRY_BATCH)
            .min(circle.invitation_count);
        for index in start..end {
            if let Some(invitee) = self.invitation_order.get(&(circle_id.0, index)) {
                if self.invitations.get(&(circle_id.0, invitee.clone()))
                    == Some(InvitationStatus::Pending)
                {
                    self.invitations
                        .insert(&(circle_id.0, invitee), &InvitationStatus::Expired);
                }
            }
        }
        circle.expiry_cursor = end;
        let finished = end >= circle.invitation_count;
        if finished {
            circle.pending_invitation_count = 0;
            circle.status = CircleStatus::Cancelled;
        }
        self.circles.insert(&circle_id.0, &circle);

        Self::emit(
            "unstarted_circle_expiry_progress",
            near_sdk::serde_json::json!({
                "circle_id": circle_id.0.to_string(),
                "member_count": circle.member_count,
                "minimum_members": circle.minimum_members,
                "expiry_cursor": circle.expiry_cursor,
                "invitation_count": circle.invitation_count,
                "finished": finished
            }),
        );
    }

    /// Refunds paid entry fees for a cancelled, never-started circle, one transfer at a time.
    /// The cursor scans the historical fee-payer index, including members who left before cancellation.
    /// Failed transfers retain the fee liability and use retry_circle_payout with a fresh nonce.
    pub fn continue_cancelled_circle_entry_fee_refunds(
        &mut self,
        circle_id: U64,
    ) -> PromiseOrValue<bool> {
        self.assert_platform_sponsored();
        if !cfg!(test) {
            env::panic_str(
                "USDC entry-fee refunds remain disabled until the Segment 3 activation gate is explicitly cleared.",
            );
        }
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        assert_eq!(
            circle.status,
            CircleStatus::Cancelled,
            "Entry-fee refunds are available only after an unstarted circle is cancelled"
        );
        assert_eq!(
            circle.pending_invitation_count, 0,
            "Resolve pending invitations before refunding"
        );
        assert_eq!(
            circle.contribution_liability_usdc_base_units, 0,
            "Refund held contribution principal before entry fees"
        );
        if circle.current_round < circle.rounds.len() as u32
            && circle.rounds[circle.current_round as usize].missed_count > 0
        {
            assert_eq!(
                circle.cleanup_member_cursor, circle.member_count,
                "Complete missed-contribution principal refunds before entry fees"
            );
        }
        assert!(
            circle.payout_in_flight.is_none(),
            "A payout/refund is already in flight"
        );
        assert!(
            circle.payout_failed.is_none(),
            "Retry the failed payout/refund before continuing"
        );
        if circle.entry_fee_refund_complete {
            return PromiseOrValue::Value(true);
        }
        if circle.entry_fee_total_usdc_base_units == 0 {
            circle.entry_fee_refund_complete = true;
            self.circles.insert(&circle.id, &circle);
            return PromiseOrValue::Value(true);
        }

        while circle.entry_fee_refund_cursor < circle.entry_fee_slot_count {
            let index = circle.entry_fee_refund_cursor;
            let member = self
                .entry_fee_payer_order
                .get(&(circle.id, index))
                .expect("Historical entry-fee payer index is missing");
            circle.entry_fee_refund_cursor = circle
                .entry_fee_refund_cursor
                .checked_add(1)
                .expect("Entry-fee refund cursor overflow");
            let record = self
                .entry_fee_payments
                .get(&(circle.id, member.clone()))
                .expect("Historical entry-fee receipt is missing");
            if record.amount_usdc_base_units == 0 || record.refund_at_ns > 0 {
                continue;
            }
            assert!(
                record.amount_usdc_base_units > 0,
                "Entry-fee receipt must have a positive amount"
            );
            let attempt = PayoutAttempt {
                nonce: 0,
                retry_count: 0,
                kind: PayoutKind::EntryFeeRefund,
                round_index: 0,
                allocation_index: index,
                recipient: member,
                gross_amount_usdc_base_units: record.amount_usdc_base_units,
                penalty_amount_usdc_base_units: 0,
                distribution_fee_usdc_base_units: 0,
                transfer_amount_usdc_base_units: record.amount_usdc_base_units,
            };
            let promise = self.begin_circle_payout(&mut circle, attempt);
            return PromiseOrValue::Promise(promise);
        }

        circle.entry_fee_refund_complete = true;
        self.circles.insert(&circle.id, &circle);
        Self::emit(
            "cancelled_circle_entry_fee_refunds_completed",
            near_sdk::serde_json::json!({
                "circle_id": circle.id.to_string(),
                "refunded_receipt_count": circle.entry_fee_paid_count,
                "refund_cursor": circle.entry_fee_refund_cursor,
                "entry_fee_total_usdc_base_units": circle.entry_fee_total_usdc_base_units.to_string()
            }),
        );
        PromiseOrValue::Value(true)
    }

    /// Removes the registration-only records of a cancelled, never-started circle.
    /// Each call deletes at most MAX_CLEANUP_BATCH records and credits the exact measured
    /// storage release to the wallet that funded those records. The circle and payer ledgers
    /// remain as compact audit records. Active circles are never eligible.
    /// Permissionless, bounded pruning for cancelled or fully settled circles.
    /// Each transaction removes at most MAX_CLEANUP_BATCH records/key-pairs.
    /// Completed circles pass a strict on-chain finality gate before any deletion starts.
    pub fn continue_circle_cleanup(&mut self, circle_id: U64) -> bool {
        self.assert_platform_sponsored();
        let platform_payer = self.platform_storage_payer();
        if self.closed_circle_tombstones.get(&circle_id.0).is_some() {
            return true;
        }
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");

        if circle.status == CircleStatus::Completed {
            assert!(
                circle.payout_in_flight.is_none() && circle.payout_failed.is_none(),
                "Circle payout must be finalized before cleanup"
            );
            assert_eq!(
                circle.contribution_liability_usdc_base_units, 0,
                "Circle still has unsettled member savings principal"
            );
            assert_eq!(
                circle.pending_invitation_count, 0,
                "Pending invitations must be resolved before cleanup"
            );
            match circle.mode {
                CircleMode::Private => {
                    assert_eq!(
                        circle.current_round as usize,
                        circle.rounds.len(),
                        "Every private round must have a successful payout callback"
                    );
                    assert!(
                        circle
                            .rounds
                            .iter()
                            .all(|round| round.status == RoundStatus::PaidOut),
                        "A private round is not finalized as paid"
                    );
                }
                CircleMode::Public => {
                    assert!(
                        circle.public_distribution_started
                            && circle.public_distribution_remaining_usdc_base_units == 0
                            && circle.public_distribution_cursor >= circle.member_count,
                        "Public distribution must be fully paid before cleanup"
                    );
                    assert!(
                        circle.rounds.iter().all(|round| {
                            round.status == RoundStatus::CycleAccumulated
                                || round.status == RoundStatus::PaidOut
                        }),
                        "A public round is not fully accumulated"
                    );
                }
            }
            for round_index in 0..circle.rounds.len() as u32 {
                let round = &circle.rounds[round_index as usize];
                assert!(
                    round.contribution_count == round.required_contribution_count
                        || round.missed_scan_complete,
                    "Every incomplete round must have a finalized missed-payment scan"
                );
                assert!(
                    !self.has_pending_default_votes(&circle, round_index),
                    "Unresolved default votes block completed-circle cleanup"
                );
            }
            for index in 0..circle.member_count {
                let member = self
                    .member_order
                    .get(&(circle.id, index))
                    .expect("Member order entry is missing at cleanup eligibility check");
                if let Some(exit) = self.member_exits.get(&(circle.id, member)) {
                    assert_eq!(
                        exit.status,
                        ExitSettlementStatus::Settled,
                        "A member exit claim is still pending settlement"
                    );
                }
            }
            circle.status = CircleStatus::Closing;
        } else if circle.status == CircleStatus::Cancelled {
            assert_eq!(
                circle.pending_invitation_count, 0,
                "Pending invitations must be resolved before cleanup"
            );
            assert_eq!(
                circle.contribution_liability_usdc_base_units, 0,
                "Cancelled-circle principal refunds must complete before storage cleanup"
            );
            if circle.current_round < circle.rounds.len() as u32
                && circle.rounds[circle.current_round as usize].missed_count > 0
            {
                assert_eq!(
                    circle.cleanup_member_cursor, circle.member_count,
                    "Complete missed-contribution principal refunds before storage cleanup"
                );
            }
            assert!(
                circle.entry_fee_total_usdc_base_units == 0 || circle.entry_fee_refund_complete,
                "Cancelled-circle entry fee refunds must complete before storage cleanup"
            );
            assert!(
                circle.payout_in_flight.is_none() && circle.payout_failed.is_none(),
                "Resolve the in-flight or failed entry-fee refund before cleanup"
            );
            circle.status = CircleStatus::Closing;
        } else {
            assert_eq!(
                circle.status,
                CircleStatus::Closing,
                "Only cancelled or fully completed circles may be cleaned up"
            );
        }

        let mut processed = 0u32;
        while processed < MAX_CLEANUP_BATCH {
            match circle.cleanup_stage {
                CleanupStage::Invitations => {
                    if circle.cleanup_invitation_cursor >= circle.invitation_count {
                        circle.cleanup_stage = CleanupStage::Contributions;
                        circle.cleanup_round_cursor = 0;
                        circle.cleanup_member_cursor = 0;
                        continue;
                    }
                    let index = circle.cleanup_invitation_cursor;
                    let before_storage = env::storage_usage();
                    let invitee = self
                        .invitation_order
                        .remove(&(circle.id, index))
                        .expect("Invitation order entry is missing during cleanup");
                    assert!(
                        self.invitations.remove(&(circle.id, invitee)).is_some(),
                        "Invitation status entry is missing during cleanup"
                    );
                    let bytes_released = before_storage
                        .checked_sub(env::storage_usage())
                        .expect("Storage usage increased while deleting an invitation");
                    self.credit_released_storage(&mut circle, &platform_payer, bytes_released);
                    circle.cleanup_invitation_cursor = circle
                        .cleanup_invitation_cursor
                        .checked_add(1)
                        .expect("Invitation cleanup cursor overflow");
                    processed += 1;
                }
                CleanupStage::Contributions => {
                    if circle.rounds.is_empty()
                        || circle.cleanup_round_cursor >= circle.rounds.len() as u32
                    {
                        circle.cleanup_stage = CleanupStage::MissedAndDefaults;
                        circle.cleanup_round_cursor = 0;
                        circle.cleanup_member_cursor = 0;
                        continue;
                    }
                    if circle.cleanup_member_cursor >= circle.member_count {
                        circle.cleanup_round_cursor += 1;
                        circle.cleanup_member_cursor = 0;
                        continue;
                    }
                    let round_index = circle.cleanup_round_cursor;
                    let member_index = circle.cleanup_member_cursor;
                    let member = self
                        .member_order
                        .get(&(circle.id, member_index))
                        .expect("Member order entry is missing during contribution cleanup");
                    let before_storage = env::storage_usage();
                    if self
                        .contributions
                        .remove(&(circle.id, round_index, member.clone()))
                        .is_some()
                    {
                        let bytes_released = before_storage
                            .checked_sub(env::storage_usage())
                            .expect("Storage usage increased while deleting a contribution");
                        self.credit_released_storage(&mut circle, &platform_payer, bytes_released);
                    }
                    circle.cleanup_member_cursor += 1;
                    processed += 1;
                }
                CleanupStage::MissedAndDefaults => {
                    if circle.rounds.is_empty()
                        || circle.cleanup_round_cursor >= circle.rounds.len() as u32
                    {
                        circle.cleanup_stage = CleanupStage::Votes;
                        circle.cleanup_vote_cursor = 0;
                        continue;
                    }
                    if circle.cleanup_member_cursor >= circle.member_count {
                        circle.cleanup_round_cursor += 1;
                        circle.cleanup_member_cursor = 0;
                        continue;
                    }
                    let round_index = circle.cleanup_round_cursor;
                    let member_index = circle.cleanup_member_cursor;
                    let member = self
                        .member_order
                        .get(&(circle.id, member_index))
                        .expect("Member order entry is missing during missed/default cleanup");
                    let before_missed = env::storage_usage();
                    if self
                        .missed_contributions
                        .remove(&(circle.id, round_index, member.clone()))
                        .is_some()
                    {
                        let bytes_released = before_missed
                            .checked_sub(env::storage_usage())
                            .expect("Storage usage increased while deleting missed evidence");
                        self.credit_released_storage(&mut circle, &platform_payer, bytes_released);
                    }
                    let before_default = env::storage_usage();
                    if self
                        .default_cases
                        .remove(&(circle.id, round_index, member.clone()))
                        .is_some()
                    {
                        let bytes_released = before_default
                            .checked_sub(env::storage_usage())
                            .expect("Storage usage increased while deleting a default case");
                        self.credit_released_storage(&mut circle, &platform_payer, bytes_released);
                    }
                    circle.cleanup_member_cursor += 1;
                    processed += 1;
                }
                CleanupStage::Votes => {
                    if circle.cleanup_vote_cursor >= circle.removal_vote_count {
                        circle.cleanup_stage = CleanupStage::ExitsAndTotals;
                        circle.cleanup_member_cursor = 0;
                        continue;
                    }
                    let vote_index = circle.cleanup_vote_cursor;
                    let before_storage = env::storage_usage();
                    let key = self
                        .removal_vote_order
                        .remove(&(circle.id, vote_index))
                        .expect("Removal-vote index is missing during cleanup");
                    assert!(
                        self.removal_votes
                            .remove(&(circle.id, key.round_index, key.target, key.voter.clone()))
                            .is_some(),
                        "Removal-vote record is missing during cleanup"
                    );
                    let bytes_released = before_storage
                        .checked_sub(env::storage_usage())
                        .expect("Storage usage increased while deleting a removal vote");
                    self.credit_released_storage(&mut circle, &platform_payer, bytes_released);
                    circle.cleanup_vote_cursor += 1;
                    processed += 1;
                }
                CleanupStage::ExitsAndTotals => {
                    if circle.cleanup_member_cursor >= circle.member_count {
                        circle.cleanup_stage = CleanupStage::EntryFees;
                        circle.cleanup_entry_fee_cursor = 0;
                        continue;
                    }
                    let member = self
                        .member_order
                        .get(&(circle.id, circle.cleanup_member_cursor))
                        .expect("Member order entry is missing during exit/total cleanup");
                    let before_exit = env::storage_usage();
                    if self
                        .member_exits
                        .remove(&(circle.id, member.clone()))
                        .is_some()
                    {
                        let bytes_released = before_exit
                            .checked_sub(env::storage_usage())
                            .expect("Storage usage increased while deleting a member exit");
                        self.credit_released_storage(&mut circle, &platform_payer, bytes_released);
                    }
                    let before_total = env::storage_usage();
                    if self
                        .member_contribution_totals
                        .remove(&(circle.id, member.clone()))
                        .is_some()
                    {
                        let bytes_released = before_total
                            .checked_sub(env::storage_usage())
                            .expect("Storage usage increased while deleting member totals");
                        self.credit_released_storage(&mut circle, &platform_payer, bytes_released);
                    }
                    let before_defaulted = env::storage_usage();
                    let payer = self
                        .ever_defaulted_payers
                        .remove(&(circle.id, member.clone()));
                    let removed_flag = self.ever_defaulted.remove(&(circle.id, member.clone()));
                    if payer.is_some() {
                        let bytes_released = before_defaulted
                            .checked_sub(env::storage_usage())
                            .expect("Storage usage increased while deleting default history");
                        if removed_flag.is_some() {
                            self.credit_released_storage(
                                &mut circle,
                                &platform_payer,
                                bytes_released,
                            );
                        }
                    }
                    circle.cleanup_member_cursor += 1;
                    processed += 1;
                }
                CleanupStage::EntryFees => {
                    if circle.cleanup_entry_fee_cursor >= circle.entry_fee_slot_count {
                        circle.cleanup_stage = CleanupStage::Members;
                        circle.cleanup_member_cursor = 0;
                        continue;
                    }
                    let index = circle.cleanup_entry_fee_cursor;
                    let before_storage = env::storage_usage();
                    let member = self
                        .entry_fee_payer_order
                        .remove(&(circle.id, index))
                        .expect("Entry-fee payer index is missing during cleanup");
                    assert!(
                        self.entry_fee_payments
                            .remove(&(circle.id, member.clone()))
                            .is_some(),
                        "Entry-fee receipt is missing during cleanup"
                    );
                    let bytes_released = before_storage
                        .checked_sub(env::storage_usage())
                        .expect("Storage usage increased while deleting an entry-fee receipt");
                    self.credit_released_storage(&mut circle, &platform_payer, bytes_released);
                    circle.cleanup_entry_fee_cursor += 1;
                    processed += 1;
                }
                CleanupStage::Members => {
                    if circle.cleanup_member_cursor >= circle.member_count {
                        circle.cleanup_stage = CleanupStage::Rounds;
                        continue;
                    }
                    let index = circle.cleanup_member_cursor;
                    let order_before_storage = env::storage_usage();
                    let account = self
                        .member_order
                        .remove(&(circle.id, index))
                        .expect("Member order entry is missing during cleanup");
                    let slot_payer = self
                        .member_order_payers
                        .remove(&(circle.id, index))
                        .expect("Member order payer is missing during cleanup");
                    let order_bytes_released = order_before_storage
                        .checked_sub(env::storage_usage())
                        .expect("Storage usage increased while deleting a member-order slot");
                    self.credit_released_storage(&mut circle, &slot_payer, order_bytes_released);

                    let member_before_storage = env::storage_usage();
                    assert!(
                        self.members.remove(&(circle.id, account.clone())).is_some(),
                        "Member record is missing during cleanup"
                    );
                    let member_bytes_released = member_before_storage
                        .checked_sub(env::storage_usage())
                        .expect("Storage usage increased while deleting a member");
                    self.credit_released_storage(
                        &mut circle,
                        &platform_payer,
                        member_bytes_released,
                    );

                    let (position_bytes, row_release, count_release) =
                        self.remove_member_circle_index(circle.id, &account);
                    self.credit_released_shared_storage(
                        &mut circle,
                        &platform_payer,
                        position_bytes,
                    );
                    if let Some((funding_circle_id, row_bytes)) = row_release {
                        self.credit_released_shared_storage_for_circle(
                            funding_circle_id,
                            &platform_payer,
                            row_bytes,
                            &mut circle,
                        );
                    }
                    if let Some((funding_circle_id, count_bytes)) = count_release {
                        self.credit_released_shared_storage_for_circle(
                            funding_circle_id,
                            &platform_payer,
                            count_bytes,
                            &mut circle,
                        );
                    }
                    circle.cleanup_member_cursor += 1;
                    processed += 1;
                }
                CleanupStage::Rounds => {
                    if !circle.rounds.is_empty() {
                        let before_storage = env::storage_usage();
                        circle.rounds.clear();
                        circle.current_round = 0;
                        circle.public_distribution_started = false;
                        circle.public_distribution_cursor = 0;
                        circle.public_distribution_total_usdc_base_units = 0;
                        circle.public_distribution_remaining_usdc_base_units = 0;
                        self.circles.insert(&circle.id, &circle);
                        let bytes_released = before_storage
                            .checked_sub(env::storage_usage())
                            .expect("Storage usage increased while clearing round schedule");
                        self.credit_released_storage(&mut circle, &platform_payer, bytes_released);
                        circle.cleanup_stage = CleanupStage::Finalize;
                        processed += 1;
                    } else {
                        circle.cleanup_stage = CleanupStage::Finalize;
                    }
                }
                CleanupStage::Finalize => {
                    assert_eq!(
                        circle.contribution_liability_usdc_base_units, 0,
                        "Cannot finalize a circle with unsettled principal"
                    );
                    assert!(
                        circle.payout_in_flight.is_none() && circle.payout_failed.is_none(),
                        "Cannot finalize a circle with unresolved payouts"
                    );
                    let mut tombstone = ClosedCircleTombstone {
                        id: circle.id,
                        creator: circle.creator.clone(),
                        mode: circle.mode,
                        status: CircleStatus::RefundingStorage,
                        original_member_count: circle.member_count,
                        original_round_count: circle.original_round_count,
                        storage_deposit_yocto: circle.storage_deposit_yocto,
                        entry_fee_total_usdc_base_units: circle.entry_fee_total_usdc_base_units,
                        created_at_ns: circle.created_at_ns,
                        closed_at_ns: 0,
                        storage_payer_count: circle.storage_payer_count,
                        refund_cursor: 0,
                        deferred_refund_count: 0,
                        refund_pass: 0,
                        storage_locked_yocto: 0,
                        total_storage_refunded_yocto: 0,
                        next_refund_nonce: 0,
                        pending_refund: PendingStorageRefund {
                            payer_bytes: [0u8; 64],
                            payer_len: 0,
                            amount_yocto: 0,
                            nonce: 0,
                            status: PendingStorageRefundStatus::Idle,
                            kind: 0,
                        },
                    };
                    let before_storage = env::storage_usage();
                    assert!(
                        self.circles.remove(&circle.id).is_some(),
                        "Circle record disappeared before tombstone creation"
                    );
                    let after_circle_remove = env::storage_usage();
                    self.closed_circle_tombstones.insert(&circle.id, &tombstone);
                    let after_tombstone = env::storage_usage();
                    let tombstone_bytes = after_tombstone
                        .checked_sub(after_circle_remove)
                        .expect("Closed-circle tombstone storage unexpectedly decreased");
                    let net_bytes_released = before_storage
                        .checked_sub(after_tombstone)
                        .expect("Closed-circle tombstone is not smaller than active circle state");
                    let tombstone_sponsor = platform_payer.clone();
                    self.credit_released_storage(
                        &mut circle,
                        &tombstone_sponsor,
                        net_bytes_released,
                    );
                    tombstone.storage_locked_yocto = u128::from(tombstone_bytes)
                        .checked_mul(env::storage_byte_cost().as_yoctonear())
                        .expect("Tombstone storage lock overflow");
                    self.closed_circle_tombstones.insert(&circle.id, &tombstone);
                    self.assert_storage_refund_liabilities_backed();
                    Self::emit(
                        "circle_pruning_complete",
                        near_sdk::serde_json::json!({
                            "circle_id": circle.id.to_string(),
                            "status": "refunding_storage",
                            "original_member_count": tombstone.original_member_count,
                            "original_round_count": tombstone.original_round_count,
                            "storage_payer_count": tombstone.storage_payer_count,
                            "tombstone_storage_locked_yocto": tombstone.storage_locked_yocto.to_string()
                        }),
                    );
                    return true;
                }
            }
        }

        self.circles.insert(&circle.id, &circle);
        Self::emit(
            "circle_cleanup_progress",
            near_sdk::serde_json::json!({
                "circle_id": circle.id.to_string(),
                "processed_records": processed,
                "cleanup_stage": format!("{:?}", circle.cleanup_stage),
                "cleanup_invitation_cursor": circle.cleanup_invitation_cursor,
                "cleanup_round_cursor": circle.cleanup_round_cursor,
                "cleanup_member_cursor": circle.cleanup_member_cursor,
                "cleanup_vote_cursor": circle.cleanup_vote_cursor,
                "cleanup_entry_fee_cursor": circle.cleanup_entry_fee_cursor,
                "removal_vote_count": circle.removal_vote_count,
                "member_count": circle.member_count
            }),
        );
        false
    }

    // Public payout weights are never creator-configurable. Claims are derived only
    // from verified on-contract contribution totals during final distribution.

    /// Freezes exactly one future, strictly increasing deadline per member. The deadline
    /// vector is persisted with the circle and there is no post-start reschedule entrypoint.
    /// AjoCircle sponsors the measured persistent storage for the frozen schedule.
    pub fn start_circle(&mut self, circle_id: U64, round_deadlines_ns: Vec<U64>) {
        self.assert_platform_sponsored();
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        assert_eq!(
            circle.creator, caller,
            "Only the creator may start the circle"
        );
        assert_eq!(
            circle.status,
            CircleStatus::RegistrationClosed,
            "Circle registration must be closed first"
        );
        assert_eq!(
            circle.pending_invitation_count, 0,
            "Pending invitations must be accepted or revoked before starting"
        );
        assert!(
            circle.member_count >= circle.minimum_members,
            "Circle has not reached its minimum member count"
        );
        #[cfg(test)]
        self.pay_unpaid_entry_fees_in_test(&mut circle);
        self.assert_entry_fees_paid(&circle);
        // Public distribution is computed from immutable contribution records at
        // settlement; there is no creator-supplied or equal-share allocation vector.
        assert_eq!(
            round_deadlines_ns.len(),
            circle.member_count as usize,
            "Schedule must contain exactly one deadline per active member"
        );
        assert!(
            round_deadlines_ns.len() <= MAX_MEMBERS_PER_CIRCLE as usize,
            "Schedule exceeds the maximum circle round count"
        );
        assert!(
            round_deadlines_ns.iter().all(|deadline| deadline.0 > now),
            "Every round deadline must be in the future"
        );
        assert!(
            round_deadlines_ns
                .windows(2)
                .all(|pair| pair[0].0 < pair[1].0),
            "Round deadlines must be strictly increasing"
        );

        let before_storage = env::storage_usage();
        circle.current_round = 0;
        circle.original_round_count = round_deadlines_ns.len() as u32;
        circle.rounds_storage_payer = Some(self.platform_storage_payer());
        circle.rounds = round_deadlines_ns
            .into_iter()
            .enumerate()
            .map(|(index, deadline)| RoundRecord {
                deadline_ns: deadline.0,
                status: if index == 0 {
                    RoundStatus::Open
                } else {
                    RoundStatus::Scheduled
                },
                required_contribution_count: circle.member_count,
                contribution_count: 0,
                total_contributed_usdc_base_units: 0,
                missed_scan_cursor: 0,
                missed_scan_complete: false,
                missed_count: 0,
            })
            .collect();
        // Preallocate a fixed-size empty contribution slot for every immutable
        // member/round pair. ft_on_transfer must not require a NEAR storage deposit
        // from the contributing wallet, and the callback must not grow storage.
        for member_index in 0..circle.member_count {
            let member = self
                .member_order
                .get(&(circle.id, member_index))
                .expect("Member order entry is missing while reserving USDC contribution slots");
            assert!(
                self.member_contribution_totals
                    .get(&(circle.id, member.clone()))
                    .is_none(),
                "Member USDC total already exists before the circle starts"
            );
            self.member_contribution_totals
                .insert(&(circle.id, member.clone()), &0);
            for round_index in 0..circle.rounds.len() as u32 {
                assert!(
                    self.contributions
                        .get(&(circle.id, round_index, member.clone()))
                        .is_none(),
                    "USDC contribution slot already exists before the circle starts"
                );
                self.contributions.insert(
                    &(circle.id, round_index, member.clone()),
                    &ContributionRecord {
                        amount_usdc_base_units: 0,
                        receipt_id: [0u8; 32],
                        contributed_at_ns: 0,
                        block_height: 0,
                    },
                );
            }
        }
        circle.status = CircleStatus::Active;
        self.circles.insert(&circle_id.0, &circle);
        self.finish_platform_storage_growth(&mut circle, before_storage, 0);
        self.circles.insert(&circle_id.0, &circle);
        self.assert_storage_refund_liabilities_backed();

        Self::emit(
            "circle_started",
            near_sdk::serde_json::json!({
                "circle_id": circle_id.0.to_string(),
                "creator": caller,
                "member_count": circle.member_count,
                "round_count": circle.rounds.len(),
                "current_round": circle.current_round,
                "first_round_deadline_ns": circle.rounds[0].deadline_ns.to_string()
            }),
        );
    }

    /// Legacy unit-test compatibility. Native NEAR is not a savings asset in this contract.
    /// The production Wasm rejects this method; all user savings enter through Circle USDC.
    pub fn contribute(&mut self, circle_id: U64) {
        self.assert_platform_sponsored();
        if !cfg!(test) {
            env::panic_str(
                "Native NEAR savings contributions are disabled. Use Circle USDC ft_transfer_call.",
            );
        }
        let member = env::predecessor_account_id();
        let circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        let amount = circle.contribution_amount_usdc_base_units;
        self.record_usdc_contribution(
            circle_id.0,
            circle.current_round,
            member.clone(),
            amount,
            Self::derive_usdc_receipt_id("contribute", circle_id.0, circle.current_round, &member),
        )
        .unwrap_or_else(|error| env::panic_str(error));
    }

    /// NEP-141 receiver for the single canonical Circle-issued NEAR Testnet USDC asset.
    /// The sender and scope determine the on-chain receipt ID; malformed or unused
    /// transfers return their full amount through the NEP-141 resolver.
    #[payable]
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.usdc_token_id
            || env::signer_account_id() != self.owner_id
            || env::attached_deposit().as_yoctonear() != 0
        {
            return PromiseOrValue::Value(amount);
        }

        let request: UsdcContributionMessage = match near_sdk::serde_json::from_str(&msg) {
            Ok(value) => value,
            Err(_) => return PromiseOrValue::Value(amount),
        };
        if request.version != 1 {
            return PromiseOrValue::Value(amount);
        }

        match request.action.as_str() {
            "contribute" => {
                let receipt_id = Self::derive_usdc_receipt_id(
                    "contribute",
                    request.circle_id.0,
                    request.round_index,
                    &sender_id,
                );
                match self.record_usdc_contribution(
                    request.circle_id.0,
                    request.round_index,
                    sender_id,
                    amount.0,
                    receipt_id,
                ) {
                    Ok(()) => PromiseOrValue::Value(U128(0)),
                    Err(_) => PromiseOrValue::Value(amount),
                }
            }
            "entry_fee" if request.round_index == 0 => {
                let receipt_id =
                    Self::derive_usdc_receipt_id("entry_fee", request.circle_id.0, 0, &sender_id);
                match self.record_usdc_entry_fee(
                    request.circle_id.0,
                    sender_id,
                    amount.0,
                    receipt_id,
                ) {
                    Ok(()) => PromiseOrValue::Value(U128(0)),
                    Err(_) => PromiseOrValue::Value(amount),
                }
            }
            _ => PromiseOrValue::Value(amount),
        }
    }

    /// Returns the deterministic idempotency receipt for the supplied wallet and scope.
    /// The message passed to ft_transfer_call contains action, circle_id, and round_index.
    pub fn get_usdc_receipt_id(
        &self,
        action: String,
        circle_id: U64,
        round_index: u32,
        member: AccountId,
    ) -> Option<String> {
        if action == "entry_fee" && round_index != 0 {
            return None;
        }
        if action != "entry_fee" && action != "contribute" {
            return None;
        }
        Some(encode_receipt_id(&Self::derive_usdc_receipt_id(
            &action,
            circle_id.0,
            round_index,
            &member,
        )))
    }

    fn derive_usdc_receipt_id(
        action: &str,
        circle_id: CircleId,
        round_index: u32,
        member: &AccountId,
    ) -> [u8; 32] {
        let mut payload = b"ajocircle:usdc-receipt:v1".to_vec();
        payload.push(0);
        payload.extend_from_slice(action.as_bytes());
        payload.push(0);
        payload.extend_from_slice(&circle_id.to_le_bytes());
        payload.extend_from_slice(&round_index.to_le_bytes());
        payload.extend_from_slice(member.as_bytes());
        let digest = env::sha256(&payload);
        digest
            .try_into()
            .expect("SHA-256 must produce an exact 32-byte USDC receipt ID")
    }

    /// Records a one-time 0.25 USDC fee for a member of a circle that has not started.
    /// The EntryFeeRecord and payer-order index were preallocated when the member joined.
    fn record_usdc_entry_fee(
        &mut self,
        circle_id: CircleId,
        member: AccountId,
        amount_usdc_base_units: u128,
        receipt_id: [u8; 32],
    ) -> Result<(), &'static str> {
        if amount_usdc_base_units != USDC_ENTRY_FEE_BASE_UNITS {
            return Err("Circle entry fee must be exactly 0.25 USDC");
        }
        let mut circle = self
            .circles
            .get(&circle_id)
            .ok_or("Circle does not exist")?;
        if circle.status != CircleStatus::RegistrationOpen
            && circle.status != CircleStatus::RegistrationClosed
        {
            return Err("Circle entry fee is accepted only before the circle starts");
        }
        if self.members.get(&(circle_id, member.clone())).is_none() {
            return Err("Entry-fee sender is not a member of this circle");
        }
        let receipt = self
            .entry_fee_payments
            .get(&(circle_id, member.clone()))
            .ok_or("Entry-fee receipt slot was not preallocated at membership")?;
        if receipt.amount_usdc_base_units != 0 || receipt.receipt_id != [0u8; 32] {
            return Err("Member has already paid the entry fee for this circle");
        }
        if receipt_id == [0u8; 32] {
            return Err("Entry-fee receipt ID must be non-zero");
        }

        let storage_before = env::storage_usage();
        self.record_entry_fee(&mut circle, &member, amount_usdc_base_units, receipt_id)?;
        self.circles.insert(&circle_id, &circle);
        assert_eq!(
            env::storage_usage(),
            storage_before,
            "USDC entry-fee receipt unexpectedly increased contract storage"
        );
        Ok(())
    }

    /// All validation completes before writes. Each contribution slot and member-total
    /// key was preallocated at start_circle so this receiver callback cannot need NEAR
    /// storage from the member and cannot increase persistent storage usage.
    fn record_usdc_contribution(
        &mut self,
        circle_id: CircleId,
        round_index: u32,
        member: AccountId,
        amount_usdc_base_units: u128,
        receipt_id: [u8; 32],
    ) -> Result<(), &'static str> {
        if amount_usdc_base_units == 0 || receipt_id == [0u8; 32] {
            return Err("USDC amount and receipt ID must be non-zero");
        }
        let mut circle = self
            .circles
            .get(&circle_id)
            .ok_or("Circle does not exist")?;
        if circle.status != CircleStatus::Active {
            return Err("Circle is not active");
        }
        if self.members.get(&(circle_id, member.clone())).is_none() {
            return Err("Sender is not a member of this circle");
        }
        if self
            .member_exits
            .get(&(circle_id, member.clone()))
            .is_some()
        {
            return Err("Member has an exit pending settlement");
        }
        if round_index != circle.current_round || (round_index as usize) >= circle.rounds.len() {
            return Err("Contribution does not target the current round");
        }
        if amount_usdc_base_units != circle.contribution_amount_usdc_base_units {
            return Err("USDC amount must exactly equal the configured contribution amount");
        }

        let now = env::block_timestamp();
        let round = &circle.rounds[round_index as usize];
        let deadline_ns = round.deadline_ns;
        let round_status = round.status;
        let missed_scan_complete = round.missed_scan_complete;
        let has_missed_record = self
            .missed_contributions
            .get(&(circle_id, round_index, member.clone()))
            .is_some();
        let private_cure_deadline_ns = deadline_ns
            .checked_add(PUBLIC_DEFAULT_VOTE_WINDOW_NS)
            .unwrap_or(u64::MAX);
        let late_private_cure = circle.mode == CircleMode::Private
            && round_status == RoundStatus::DeadlinePassed
            && missed_scan_complete
            && has_missed_record
            && now < private_cure_deadline_ns;
        if round_status != RoundStatus::Open && !late_private_cure {
            return Err("Round is not accepting contributions");
        }
        if now >= deadline_ns && !late_private_cure {
            return Err("Contribution deadline has passed");
        }

        let slot = self
            .contributions
            .get(&(circle_id, round_index, member.clone()))
            .ok_or("USDC contribution slot was not reserved at circle start")?;
        if slot.amount_usdc_base_units != 0 || slot.receipt_id != [0u8; 32] {
            return Err("Member has already contributed to this round");
        }
        let current_member_total = self
            .member_contribution_totals
            .get(&(circle_id, member.clone()))
            .ok_or("Member USDC total slot was not reserved at circle start")?;
        let next_member_total = current_member_total
            .checked_add(amount_usdc_base_units)
            .ok_or("Member USDC lifetime total overflow")?;
        let next_round_total = round
            .total_contributed_usdc_base_units
            .checked_add(amount_usdc_base_units)
            .ok_or("Round USDC total overflow")?;
        let next_global_liability = self
            .contribution_liability_usdc_base_units
            .checked_add(amount_usdc_base_units)
            .ok_or("Global USDC contribution liability overflow")?;
        let next_circle_liability = circle
            .contribution_liability_usdc_base_units
            .checked_add(amount_usdc_base_units)
            .ok_or("Circle USDC contribution liability overflow")?;
        let next_count = round
            .contribution_count
            .checked_add(1)
            .ok_or("Round contribution count overflow")?;
        if next_count > round.required_contribution_count || next_count > circle.member_count {
            return Err("Round contribution count exceeds active membership");
        }

        let storage_before = env::storage_usage();
        self.contributions.insert(
            &(circle_id, round_index, member.clone()),
            &ContributionRecord {
                amount_usdc_base_units,
                receipt_id,
                contributed_at_ns: now,
                block_height: env::block_height(),
            },
        );
        self.member_contribution_totals
            .insert(&(circle_id, member.clone()), &next_member_total);
        let current_round = &mut circle.rounds[round_index as usize];
        current_round.contribution_count = next_count;
        current_round.total_contributed_usdc_base_units = next_round_total;
        if next_count == current_round.required_contribution_count {
            current_round.status = RoundStatus::ContributionsComplete;
        }
        self.contribution_liability_usdc_base_units = next_global_liability;
        circle.contribution_liability_usdc_base_units = next_circle_liability;
        self.circles.insert(&circle_id, &circle);

        // A storage-size change here would mean the preallocation invariant was broken.
        // Panic to revert the token receiver call so the NEP-141 resolver returns tokens.
        assert_eq!(
            env::storage_usage(),
            storage_before,
            "USDC receipt callback unexpectedly increased contract storage"
        );

        if late_private_cure {
            Self::emit(
                "private_usdc_contribution_late_cured",
                near_sdk::serde_json::json!({
                    "circle_id": circle_id.to_string(),
                    "member": member.clone(),
                    "round": round_index,
                    "amount_usdc_base_units": amount_usdc_base_units.to_string(),
                    "receipt_id": encode_receipt_id(&receipt_id),
                    "original_deadline_ns": deadline_ns.to_string(),
                    "contributed_at_ns": now.to_string()
                }),
            );
        }
        Self::emit(
            "usdc_contribution_recorded",
            near_sdk::serde_json::json!({
                "circle_id": circle_id.to_string(),
                "member": member,
                "round": round_index,
                "token_id": self.usdc_token_id,
                "amount_usdc_base_units": amount_usdc_base_units.to_string(),
                "receipt_id": encode_receipt_id(&receipt_id),
                "contributed_at_ns": now.to_string(),
                "round_contribution_count": circle.rounds[round_index as usize].contribution_count,
                "round_complete": circle.rounds[round_index as usize].status == RoundStatus::ContributionsComplete,
                "late_private_cure": late_private_cure
            }),
        );
        Ok(())
    }

    /// A member may leave before start; the released storage returns to AjoCircle's sponsor ledger.
    /// After start, the request becomes a pending settlement claim; no principal is transferred here.
    pub fn request_member_exit(&mut self, circle_id: U64) -> bool {
        self.assert_platform_sponsored();
        let member = env::predecessor_account_id();
        let now = env::block_timestamp();
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        assert!(
            self.members.get(&(circle_id.0, member.clone())).is_some(),
            "Caller is not a member of this circle"
        );
        assert!(
            self.member_exits
                .get(&(circle_id.0, member.clone()))
                .is_none(),
            "Member already has an exit pending settlement"
        );

        if circle.status == CircleStatus::RegistrationOpen
            || circle.status == CircleStatus::RegistrationClosed
        {
            assert_ne!(
                circle.creator, member,
                "The creator cannot leave; cancel the unstarted circle instead"
            );
            let member_position = (0..circle.member_count)
                .find(|index| self.member_order.get(&(circle.id, *index)).as_ref() == Some(&member))
                .expect("Member order entry is missing for the exiting wallet");
            let last_member_position = circle.member_count - 1;

            let member_before_storage = env::storage_usage();
            assert!(
                self.members.remove(&(circle.id, member.clone())).is_some(),
                "Member record is missing during voluntary exit"
            );
            let member_bytes_released = member_before_storage
                .checked_sub(env::storage_usage())
                .expect("Storage usage increased while removing the exiting member");
            let platform_payer = self.platform_storage_payer();
            self.credit_released_storage(&mut circle, &platform_payer, member_bytes_released);

            let (position_bytes, row_release, count_release) =
                self.remove_member_circle_index(circle.id, &member);
            self.credit_released_shared_storage(&mut circle, &platform_payer, position_bytes);
            if let Some((funding_circle_id, row_bytes)) = row_release {
                self.credit_released_shared_storage_for_circle(
                    funding_circle_id,
                    &platform_payer,
                    row_bytes,
                    &mut circle,
                );
            }
            if let Some((funding_circle_id, count_bytes)) = count_release {
                self.credit_released_shared_storage_for_circle(
                    funding_circle_id,
                    &platform_payer,
                    count_bytes,
                    &mut circle,
                );
            }

            let slot_payer = self
                .member_order_payers
                .get(&(circle.id, member_position))
                .expect("Exiting member-order slot payer is missing");
            let order_before_storage = env::storage_usage();
            for index in member_position..last_member_position {
                let next_index = index + 1;
                let next_member = self
                    .member_order
                    .get(&(circle.id, next_index))
                    .expect("Next member-order entry is missing during compaction");
                let next_payer = self
                    .member_order_payers
                    .get(&(circle.id, next_index))
                    .expect("Next member-order payer is missing during compaction");
                self.member_order.insert(&(circle.id, index), &next_member);
                self.member_order_payers
                    .insert(&(circle.id, index), &next_payer);
            }
            assert!(
                self.member_order
                    .remove(&(circle.id, last_member_position))
                    .is_some(),
                "Last member-order entry could not be removed"
            );
            assert!(
                self.member_order_payers
                    .remove(&(circle.id, last_member_position))
                    .is_some(),
                "Last member-order payer could not be removed"
            );
            let order_bytes_released = order_before_storage
                .checked_sub(env::storage_usage())
                .expect("Storage usage increased while shifting the member-order list");
            self.credit_released_storage(&mut circle, &slot_payer, order_bytes_released);

            if self.invitations.get(&(circle.id, member.clone()))
                == Some(InvitationStatus::Accepted)
            {
                self.invitations
                    .insert(&(circle.id, member.clone()), &InvitationStatus::Revoked);
            }
            circle.member_count = circle
                .member_count
                .checked_sub(1)
                .expect("Circle member count underflow during exit");
            if circle.status == CircleStatus::RegistrationClosed
                && now < circle.registration_deadline_ns
                && circle.member_count + circle.pending_invitation_count < circle.maximum_members
            {
                circle.status = CircleStatus::RegistrationOpen;
            }
            self.circles.insert(&circle_id.0, &circle);
            self.assert_storage_refund_liabilities_backed();

            Self::emit(
                "member_left_before_start",
                near_sdk::serde_json::json!({
                    "circle_id": circle.id.to_string(),
                    "member": member,
                    "member_count": circle.member_count,
                    "storage_bytes_released_to_platform_sponsor": member_bytes_released.to_string(),
                    "storage_bytes_released_to_platform_order_sponsor": order_bytes_released.to_string(),
                    "order_slot_sponsor": slot_payer
                }),
            );
            return true;
        }

        assert_eq!(
            circle.status,
            CircleStatus::Active,
            "Member exit is not available for this circle status"
        );
        assert!(
            (circle.current_round as usize) < circle.rounds.len(),
            "Circle round schedule is missing"
        );
        assert!(
            circle.payout_in_flight.is_none() && circle.payout_failed.is_none(),
            "Resolve the current payout before requesting an exit"
        );
        assert!(
            self.active_member_count(&circle) > 1,
            "At least one active contributor must remain in the circle"
        );
        let round = &circle.rounds[circle.current_round as usize];
        assert!(
            round.status == RoundStatus::ContributionsComplete
                || (now >= round.deadline_ns && round.missed_scan_complete),
            "Wait for round completion or the full missed-contribution scan before requesting exit"
        );

        let (gross, penalty_basis, penalty_bps, penalty) = if circle.mode == CircleMode::Public {
            self.member_exit_claim(&circle, &member)
        } else {
            (0, 0, 0, 0)
        };
        let private_payout_position = if circle.mode == CircleMode::Private {
            Some(
                (0..circle.member_count)
                    .find(|index| {
                        self.member_order.get(&(circle.id, *index)).as_ref() == Some(&member)
                    })
                    .expect("Member order entry is missing for exiting private member"),
            )
        } else {
            None
        };
        let exit_status =
            if private_payout_position.is_some_and(|position| position < circle.current_round) {
                ExitSettlementStatus::Settled
            } else {
                ExitSettlementStatus::PendingSettlement
            };
        let before_storage = env::storage_usage();
        self.prepare_platform_storage_sponsor(&mut circle);
        self.member_exits.insert(
            &(circle.id, member.clone()),
            &MemberExitRecord {
                storage_payer: self.platform_storage_payer(),
                reason: ExitReason::Voluntary,
                status: exit_status,
                requested_at_ns: now,
                source_round: circle.current_round,
                gross_claim_usdc_base_units: gross,
                penalty_basis_usdc_base_units: penalty_basis,
                penalty_bps,
                penalty_usdc_base_units: penalty,
            },
        );
        let current_round = circle.current_round;
        self.exclude_member_from_future_rounds(&mut circle, &member, current_round);
        if let Some(mut case) =
            self.default_cases
                .get(&(circle.id, circle.current_round, member.clone()))
        {
            if case.status == DefaultCaseStatus::PendingVote {
                case.status = DefaultCaseStatus::VoluntaryExitRequested;
                self.default_cases
                    .insert(&(circle.id, circle.current_round, member.clone()), &case);
            }
        }
        self.circles.insert(&circle.id, &circle);
        self.finish_platform_storage_growth(&mut circle, before_storage, 0);
        self.circles.insert(&circle.id, &circle);
        self.assert_storage_refund_liabilities_backed();

        Self::emit(
            "member_exit_requested",
            near_sdk::serde_json::json!({
                "circle_id": circle.id.to_string(),
                "member": member,
                "reason": "voluntary",
                "source_round": circle.current_round,
                "gross_claim_usdc_base_units": gross.to_string(),
                "penalty_basis_usdc_base_units": penalty_basis.to_string(),
                "penalty_bps": penalty_bps,
                "penalty_usdc_base_units": penalty.to_string(),
                "settlement": if exit_status == ExitSettlementStatus::Settled { "already_paid_out" } else { "pending" }
            }),
        );
        false
    }

    /// Permissionless, bounded scan of the current round after its immutable deadline.
    /// AjoCircle sponsors any new missed/default evidence records.
    pub fn record_missed_contributions(
        &mut self,
        circle_id: U64,
        limit: Option<u32>,
    ) -> DefaultScanSummary {
        self.assert_platform_sponsored();
        let now = env::block_timestamp();
        let batch_limit = Self::checked_batch_limit(limit);
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        assert_eq!(
            circle.status,
            CircleStatus::Active,
            "Missed contributions require an active circle"
        );
        assert!(
            (circle.current_round as usize) < circle.rounds.len(),
            "Circle round schedule is missing"
        );

        let round_index = circle.current_round;
        let round_deadline = circle.rounds[round_index as usize].deadline_ns;
        assert!(
            now >= round_deadline,
            "Contribution deadline has not passed"
        );
        let before_storage = env::storage_usage();
        self.prepare_platform_storage_sponsor(&mut circle);
        let member_count = circle.member_count;
        let required_contribution_count =
            circle.rounds[round_index as usize].required_contribution_count;

        if circle.rounds[round_index as usize].contribution_count == required_contribution_count {
            circle.rounds[round_index as usize].status = RoundStatus::ContributionsComplete;
            let round = &mut circle.rounds[round_index as usize];
            round.missed_scan_cursor = member_count;
            round.missed_scan_complete = true;
            self.circles.insert(&circle_id.0, &circle);
            self.finish_platform_storage_growth(&mut circle, before_storage, 0);
            self.circles.insert(&circle_id.0, &circle);
            return Self::default_scan_summary(
                circle_id.0,
                round_index,
                &circle.rounds[round_index as usize],
                0,
            );
        }

        assert!(
            circle.rounds[round_index as usize].status == RoundStatus::Open
                || circle.rounds[round_index as usize].status == RoundStatus::DeadlinePassed,
            "Round is not eligible for missed-contribution recording"
        );
        circle.rounds[round_index as usize].status = RoundStatus::DeadlinePassed;

        let mut processed = 0u32;
        while processed < batch_limit
            && circle.rounds[round_index as usize].missed_scan_cursor < member_count
        {
            let index = circle.rounds[round_index as usize].missed_scan_cursor;
            let member = self
                .member_order
                .get(&(circle.id, index))
                .expect("Member order entry is missing during default scan");
            let is_exit_pending = self
                .member_exits
                .get(&(circle.id, member.clone()))
                .is_some();
            let contribution_exists = self
                .contributions
                .get(&(circle.id, round_index, member.clone()))
                .map(|record| record.amount_usdc_base_units > 0)
                .unwrap_or(false);
            if !is_exit_pending
                && !contribution_exists
                && self
                    .missed_contributions
                    .get(&(circle.id, round_index, member.clone()))
                    .is_none()
            {
                self.missed_contributions.insert(
                    &(circle.id, round_index, member.clone()),
                    &MissedContributionRecord {
                        storage_payer: self.platform_storage_payer(),
                        expected_amount_usdc_base_units: circle.contribution_amount_usdc_base_units,
                        deadline_ns: round_deadline,
                        recorded_at_ns: now,
                    },
                );
                let round = &mut circle.rounds[round_index as usize];
                round.missed_count = round
                    .missed_count
                    .checked_add(1)
                    .expect("Missed contribution count overflow");

                if circle.mode == CircleMode::Public {
                    let vote_deadline = round_deadline
                        .checked_add(PUBLIC_DEFAULT_VOTE_WINDOW_NS)
                        .expect("Public default vote deadline overflow");
                    let eligible_voters = self
                        .active_member_count(&circle)
                        .checked_sub(1)
                        .expect("A public default requires another active member to vote");
                    let status = if now < vote_deadline {
                        DefaultCaseStatus::PendingVote
                    } else {
                        DefaultCaseStatus::VoteWindowExpired
                    };
                    self.default_cases.insert(
                        &(circle.id, round_index, member.clone()),
                        &DefaultCaseRecord {
                            storage_payer: self.platform_storage_payer(),
                            status,
                            vote_deadline_ns: vote_deadline,
                            eligible_voter_count: eligible_voters,
                            approve_count: 0,
                            reject_count: 0,
                            recorded_at_ns: now,
                        },
                    );
                    if self
                        .ever_defaulted
                        .get(&(circle.id, member.clone()))
                        .is_none()
                    {
                        self.ever_defaulted
                            .insert(&(circle.id, member.clone()), &true);
                        self.ever_defaulted_payers
                            .insert(&(circle.id, member.clone()), &self.owner_id);
                    }
                    Self::emit(
                        "public_contribution_missed",
                        near_sdk::serde_json::json!({
                            "circle_id": circle.id.to_string(),
                            "member": member,
                            "round": round_index,
                            "expected_amount_usdc_base_units": circle.contribution_amount_usdc_base_units.to_string(),
                            "deadline_ns": round_deadline.to_string(),
                            "vote_deadline_ns": vote_deadline.to_string()
                        }),
                    );
                } else {
                    Self::emit(
                        "private_contribution_missed",
                        near_sdk::serde_json::json!({
                            "circle_id": circle.id.to_string(),
                            "member": member,
                            "round": round_index,
                            "expected_amount_usdc_base_units": circle.contribution_amount_usdc_base_units.to_string(),
                            "deadline_ns": round_deadline.to_string()
                        }),
                    );
                }
            }

            circle.rounds[round_index as usize].missed_scan_cursor =
                index.checked_add(1).expect("Missed scan cursor overflow");
            processed += 1;
        }

        if circle.rounds[round_index as usize].missed_scan_cursor >= member_count {
            circle.rounds[round_index as usize].missed_scan_complete = true;
        }
        self.circles.insert(&circle_id.0, &circle);
        self.finish_platform_storage_growth(&mut circle, before_storage, 0);
        self.circles.insert(&circle_id.0, &circle);
        self.assert_storage_refund_liabilities_backed();

        let summary = Self::default_scan_summary(
            circle.id,
            round_index,
            &circle.rounds[round_index as usize],
            processed,
        );
        Self::emit(
            "missed_contribution_scan_progress",
            near_sdk::serde_json::json!({
                "circle_id": circle.id.to_string(),
                "round": round_index,
                "processed_count": processed,
                "missed_count": summary.missed_count,
                "next_cursor": summary.next_cursor,
                "complete": summary.complete
            }),
        );
        summary
    }

    /// One member may vote once on a public missed-payment case. Removal requires unanimous
    /// approval from every other member; any rejection closes the proposal without removing them.
    /// The final YES starts a nonce-bound Circle USDC exit payout before future rounds continue.
    pub fn vote_remove_defaulted_member(
        &mut self,
        circle_id: U64,
        round_index: u32,
        target: AccountId,
        approve: bool,
    ) -> bool {
        self.assert_platform_sponsored();
        let voter = env::predecessor_account_id();
        let now = env::block_timestamp();
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        assert_eq!(circle.status, CircleStatus::Active, "Circle is not active");
        assert_eq!(
            circle.mode,
            CircleMode::Public,
            "Removal votes are public-circle only"
        );
        assert!(
            circle.payout_in_flight.is_none() && circle.payout_failed.is_none(),
            "Resolve the existing USDC payout before voting on another default exit"
        );
        assert!(
            self.members.get(&(circle.id, voter.clone())).is_some()
                && self.member_exits.get(&(circle.id, voter.clone())).is_none(),
            "Only active circle members may vote"
        );
        assert_ne!(voter, target, "Target cannot vote on their own removal");
        assert_eq!(
            round_index, circle.current_round,
            "Only the current round default may be voted on"
        );
        assert!(
            self.members.get(&(circle.id, target.clone())).is_some()
                && self
                    .member_exits
                    .get(&(circle.id, target.clone()))
                    .is_none(),
            "Target is not an active circle member"
        );
        let key = (circle.id, round_index, target.clone());
        let mut case = self
            .default_cases
            .get(&key)
            .expect("Target has no verified public default case");
        assert_eq!(
            case.status,
            DefaultCaseStatus::PendingVote,
            "Default removal vote is not open"
        );
        assert!(
            now < case.vote_deadline_ns,
            "Public default vote window has closed"
        );
        let vote_key = (circle.id, round_index, target.clone(), voter.clone());
        assert!(
            self.removal_votes.get(&vote_key).is_none(),
            "Member has already voted on this default event"
        );

        let before_storage = env::storage_usage();
        self.prepare_platform_storage_sponsor(&mut circle);
        let vote_index = circle.removal_vote_count;
        self.removal_vote_order.insert(
            &(circle.id, vote_index),
            &RemovalVoteKey {
                round_index,
                target: target.clone(),
                voter: voter.clone(),
            },
        );
        circle.removal_vote_count = circle
            .removal_vote_count
            .checked_add(1)
            .expect("Removal vote index overflow");
        self.removal_votes.insert(&vote_key, &approve);
        if approve {
            case.approve_count = case
                .approve_count
                .checked_add(1)
                .expect("Default approval vote count overflow");
            if case.approve_count == case.eligible_voter_count {
                case.status = DefaultCaseStatus::RemovalApproved;
                let (gross, penalty_basis, penalty_bps, requested_penalty) =
                    self.member_exit_claim(&circle, &target);
                let distribution_fee = Self::basis_point_amount(gross, DISTRIBUTION_FEE_BPS);
                let maximum_penalty = gross.saturating_sub(distribution_fee).saturating_sub(1);
                let penalty = requested_penalty.min(maximum_penalty);
                if gross > 0 && !cfg!(test) {
                    env::panic_str(
                        "USDC default-exit payout remains disabled until the Segment 3 activation gate is explicitly cleared."
                    );
                }
                let exit_status = if gross == 0 {
                    ExitSettlementStatus::Settled
                } else {
                    ExitSettlementStatus::PendingSettlement
                };
                self.member_exits.insert(
                    &(circle.id, target.clone()),
                    &MemberExitRecord {
                        storage_payer: self.platform_storage_payer(),
                        reason: ExitReason::PublicDefaultRemoval,
                        status: exit_status,
                        requested_at_ns: now,
                        source_round: round_index,
                        gross_claim_usdc_base_units: gross,
                        penalty_basis_usdc_base_units: penalty_basis,
                        penalty_bps,
                        penalty_usdc_base_units: penalty,
                    },
                );
                self.exclude_member_from_future_rounds(&mut circle, &target, round_index);
                Self::emit(
                    "public_member_removal_approved",
                    near_sdk::serde_json::json!({
                        "circle_id": circle.id.to_string(),
                        "member": target,
                        "round": round_index,
                        "reason": "unanimous_default_vote",
                        "gross_claim_usdc_base_units": gross.to_string(),
                        "penalty_basis_usdc_base_units": penalty_basis.to_string(),
                        "penalty_bps": penalty_bps,
                        "penalty_usdc_base_units": penalty.to_string(),
                        "distribution_fee_usdc_base_units": distribution_fee.to_string(),
                        "settlement": if gross == 0 { "settled_no_claim" } else { "pending" }
                    }),
                );
            }
        } else {
            case.reject_count = case
                .reject_count
                .checked_add(1)
                .expect("Default rejection vote count overflow");
            case.status = DefaultCaseStatus::RemovalRejected;
        }
        self.default_cases.insert(&key, &case);
        self.circles.insert(&circle.id, &circle);
        self.finish_platform_storage_growth(&mut circle, before_storage, 0);
        self.circles.insert(&circle.id, &circle);
        self.assert_storage_refund_liabilities_backed();

        let removal_approved = case.status == DefaultCaseStatus::RemovalApproved;
        Self::emit(
            "public_default_removal_vote",
            near_sdk::serde_json::json!({
                "circle_id": circle.id.to_string(),
                "target_member": target,
                "voter_member": voter,
                "round": round_index,
                "approve": approve,
                "approve_count": case.approve_count,
                "reject_count": case.reject_count,
                "eligible_voter_count": case.eligible_voter_count,
                "case_status": case.status
            }),
        );
        if removal_approved {
            let exit = self
                .member_exits
                .get(&(circle.id, target.clone()))
                .expect("Approved public-default exit record is missing");
            if exit.status == ExitSettlementStatus::PendingSettlement {
                let distribution_fee = Self::basis_point_amount(
                    exit.gross_claim_usdc_base_units,
                    DISTRIBUTION_FEE_BPS,
                );
                let transfer_amount = exit
                    .gross_claim_usdc_base_units
                    .checked_sub(exit.penalty_usdc_base_units)
                    .and_then(|value| value.checked_sub(distribution_fee))
                    .expect("Default-exit deductions exceed the USDC claim");
                let attempt = PayoutAttempt {
                    nonce: 0,
                    retry_count: 0,
                    kind: PayoutKind::PublicDefaultExit,
                    round_index,
                    allocation_index: 0,
                    recipient: target,
                    gross_amount_usdc_base_units: exit.gross_claim_usdc_base_units,
                    penalty_amount_usdc_base_units: exit.penalty_usdc_base_units,
                    distribution_fee_usdc_base_units: distribution_fee,
                    transfer_amount_usdc_base_units: transfer_amount,
                };
                let _payout = self.begin_circle_payout(&mut circle, attempt);
            }
        }
        removal_approved
    }

    /// Anyone may close a default vote after the immutable 24-hour window.
    /// Closing a vote does not erase missed-payment evidence or transfer any funds.
    pub fn close_default_vote_window(
        &mut self,
        circle_id: U64,
        round_index: u32,
        target: AccountId,
    ) -> bool {
        self.assert_platform_sponsored();
        let key = (circle_id.0, round_index, target.clone());
        let mut case = self
            .default_cases
            .get(&key)
            .expect("Public default case does not exist");
        assert_eq!(
            case.status,
            DefaultCaseStatus::PendingVote,
            "Default vote is not pending"
        );
        assert!(
            env::block_timestamp() >= case.vote_deadline_ns,
            "Public default vote window is still open"
        );
        case.status = DefaultCaseStatus::VoteWindowExpired;
        self.default_cases.insert(&key, &case);
        Self::emit(
            "public_default_vote_window_closed",
            near_sdk::serde_json::json!({
                "circle_id": circle_id.0.to_string(),
                "target_member": target,
                "round": round_index,
                "approve_count": case.approve_count,
                "reject_count": case.reject_count,
                "status": case.status
            }),
        );
        true
    }

    /// Cancels an active circle 24 hours after an incomplete contribution deadline.
    /// Completed payouts remain final; this begins refunds only for principal still held
    /// by the contract. Every refund is a separate, fingerprinted USDC transfer.
    pub fn cancel_missed_contribution_circle(&mut self, circle_id: U64) -> PromiseOrValue<bool> {
        self.assert_platform_sponsored();
        if !cfg!(test) {
            env::panic_str("Missed-contribution cancellation and USDC refunds remain disabled until the Segment 3 activation gate is explicitly cleared.");
        }
        let now = env::block_timestamp();
        let mut circle = self.circles.get(&circle_id.0).expect("Circle does not exist");
        assert!(
            self.missed_contribution_cancellation_eligible(&circle, now),
            "Circle is not eligible for missed-contribution cancellation"
        );

        let mut claim_total = 0u128;
        for index in 0..circle.member_count {
            let member = self.member_order.get(&(circle.id, index))
                .expect("Member order entry is missing during cancellation preflight");
            claim_total = claim_total.checked_add(
                self.missed_contribution_refund_claim(&circle, &member),
            ).expect("Missed-contribution refund total overflow");
        }
        assert_eq!(
            claim_total,
            circle.contribution_liability_usdc_base_units,
            "Member refunds do not reconcile to held USDC principal"
        );
        circle.status = CircleStatus::Cancelled;
        circle.cleanup_member_cursor = 0;
        self.circles.insert(&circle.id, &circle);
        Self::emit(
            "missed_contribution_circle_cancelled",
            near_sdk::serde_json::json!({
                "circle_id": circle.id.to_string(),
                "mode": circle.mode,
                "round": circle.current_round,
                "missed_count": circle.rounds[circle.current_round as usize].missed_count,
                "refund_liability_usdc_base_units": circle.contribution_liability_usdc_base_units.to_string(),
                "deadline_ns": circle.rounds[circle.current_round as usize].deadline_ns.to_string(),
                "cancelled_at_ns": now.to_string(),
                "completed_payouts_remain_final": true
            }),
        );
        self.continue_missed_contribution_refunds(circle_id)
    }

    /// Pays one held-principal refund per call. The member cursor is reused from the
    /// cleanup record because the Circle Borsh layout is already deployed and immutable.
    pub fn continue_missed_contribution_refunds(
        &mut self,
        circle_id: U64,
    ) -> PromiseOrValue<bool> {
        self.assert_platform_sponsored();
        if !cfg!(test) {
            env::panic_str("Missed-contribution USDC refunds remain disabled until the Segment 3 activation gate is explicitly cleared.");
        }
        let mut circle = self.circles.get(&circle_id.0).expect("Circle does not exist");
        assert_eq!(circle.status, CircleStatus::Cancelled, "Circle is not cancelled");
        assert!(
            circle.rounds.get(circle.current_round as usize)
                .is_some_and(|round| round.status == RoundStatus::DeadlinePassed
                    && round.missed_scan_complete && round.missed_count > 0),
            "Circle was not cancelled under the missed-contribution policy"
        );
        assert!(
            circle.payout_in_flight.is_none() && circle.payout_failed.is_none(),
            "Resolve the in-flight or failed payout before continuing refunds"
        );

        while circle.cleanup_member_cursor < circle.member_count {
            let index = circle.cleanup_member_cursor;
            let member = self.member_order.get(&(circle.id, index))
                .expect("Member order entry is missing during principal refund");
            let claim = self.missed_contribution_refund_claim(&circle, &member);
            circle.cleanup_member_cursor = index.checked_add(1)
                .expect("Missed-contribution refund cursor overflow");
            if claim == 0 {
                continue;
            }
            self.circles.insert(&circle.id, &circle);
            let attempt = PayoutAttempt {
                nonce: 0,
                retry_count: 0,
                kind: PayoutKind::MissedContributionRefund,
                round_index: circle.current_round,
                allocation_index: index,
                recipient: member,
                gross_amount_usdc_base_units: claim,
                penalty_amount_usdc_base_units: 0,
                distribution_fee_usdc_base_units: 0,
                transfer_amount_usdc_base_units: claim,
            };
            return PromiseOrValue::Promise(self.begin_circle_payout(&mut circle, attempt));
        }

        assert_eq!(
            circle.contribution_liability_usdc_base_units, 0,
            "Circle still has held contribution principal"
        );
        self.circles.insert(&circle.id, &circle);
        Self::emit(
            "missed_contribution_principal_refunds_completed",
            near_sdk::serde_json::json!({
                "circle_id": circle.id.to_string(),
                "refund_cursor": circle.cleanup_member_cursor,
                "refund_member_count": circle.member_count,
                "contribution_liability_usdc_base_units": circle.contribution_liability_usdc_base_units.to_string()
            }),
        );
        PromiseOrValue::Value(true)
    }

    /// Creator-authorized private payout. Round index selects the immutable member-order slot.
    /// A recipient is paid only after every required member has contributed the full round pot.
    /// A privately invited member with a recorded miss may still cure it with the exact
    /// contribution after the bounded scan; partial private pots are never distributed.
    pub fn start_private_round_payout(&mut self, circle_id: U64) -> Promise {
        self.assert_platform_sponsored();
        if !cfg!(test) {
            env::panic_str("USDC payout execution remains disabled until the Segment 3 activation gate is explicitly cleared.");
        }
        let caller = env::predecessor_account_id();
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        assert_eq!(
            circle.creator, caller,
            "Only the creator may authorize a private payout"
        );
        assert_eq!(
            circle.mode,
            CircleMode::Private,
            "Private payout is for private circles only"
        );
        assert_eq!(circle.status, CircleStatus::Active, "Circle is not active");
        assert!(
            circle.payout_in_flight.is_none(),
            "A payout is already in flight"
        );
        assert!(
            circle.payout_failed.is_none(),
            "Retry the failed payout before starting another"
        );
        let round_index = circle.current_round;
        let round = circle
            .rounds
            .get(round_index as usize)
            .expect("No private payout round remains");
        assert_eq!(
            round.status,
            RoundStatus::ContributionsComplete,
            "Private payout requires every scheduled contribution; partial pots cannot be paid"
        );
        assert_eq!(
            round.contribution_count, round.required_contribution_count,
            "Private payout requires the full contribution count"
        );
        let expected_round_pot = circle
            .contribution_amount_usdc_base_units
            .checked_mul(u128::from(round.required_contribution_count))
            .expect("Expected private round pot overflow");
        assert_eq!(
            round.total_contributed_usdc_base_units, expected_round_pot,
            "Private payout amount must equal the full scheduled round pot"
        );
        let recipient = self
            .member_order
            .get(&(circle.id, round_index))
            .expect("Immutable payout-order recipient is missing");
        let amount = round.total_contributed_usdc_base_units;
        let distribution_fee = Self::basis_point_amount(amount, DISTRIBUTION_FEE_BPS);
        let transfer_amount = amount
            .checked_sub(distribution_fee)
            .expect("Distribution fee exceeds the private payout");
        circle.rounds[round_index as usize].status = RoundStatus::PayoutInFlight;
        let attempt = PayoutAttempt {
            nonce: 0,
            retry_count: 0,
            kind: PayoutKind::PrivateRound,
            round_index,
            allocation_index: 0,
            recipient,
            gross_amount_usdc_base_units: amount,
            penalty_amount_usdc_base_units: 0,
            distribution_fee_usdc_base_units: distribution_fee,
            transfer_amount_usdc_base_units: transfer_amount,
        };
        self.begin_circle_payout(&mut circle, attempt)
    }

    /// Public rounds are accumulated without transfers. Each round advances only after all
    /// active contributions are recorded or the complete missed-payment scan and votes resolve.
    pub fn advance_public_round(&mut self, circle_id: U64) -> bool {
        self.assert_platform_sponsored();
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        assert_eq!(
            circle.mode,
            CircleMode::Public,
            "Public round advancement is public-circle only"
        );
        assert_eq!(circle.status, CircleStatus::Active, "Circle is not active");
        assert!(
            circle.payout_in_flight.is_none() && circle.payout_failed.is_none(),
            "Resolve the current payout before advancing"
        );
        let round_index = circle.current_round;
        let round = circle
            .rounds
            .get(round_index as usize)
            .expect("No public contribution round remains");
        let ready = round.status == RoundStatus::ContributionsComplete
            || (round.status == RoundStatus::DeadlinePassed && round.missed_scan_complete);
        assert!(
            ready,
            "Round contributions or missed-payment scan are not complete"
        );
        assert!(
            !self.has_pending_default_votes(&circle, round_index),
            "Resolve or expire every public default vote before advancing"
        );
        circle.rounds[round_index as usize].status = RoundStatus::CycleAccumulated;
        circle.current_round = circle
            .current_round
            .checked_add(1)
            .expect("Current round overflow");
        let finished = circle.current_round as usize >= circle.rounds.len();
        if finished {
            circle.status = CircleStatus::SettlementReady;
        } else {
            circle.rounds[circle.current_round as usize].status = RoundStatus::Open;
        }
        self.circles.insert(&circle.id, &circle);
        Self::emit(
            "public_round_accumulated",
            near_sdk::serde_json::json!({ "circle_id": circle.id.to_string(), "round": round_index, "next_round": circle.current_round, "settlement_ready": finished }),
        );
        finished
    }

    /// Starts or continues deterministic public distribution. Every member's gross claim
    /// is the sum of that wallet's verified contribution records, never a creator-set weight.
    /// The contribution totals are maintained at write time so each continuation is bounded
    /// by the 100-member circle limit rather than scanning every round again.
    pub fn continue_public_distribution(&mut self, circle_id: U64) -> Promise {
        self.assert_platform_sponsored();
        if !cfg!(test) {
            env::panic_str("USDC payout execution remains disabled until the Segment 3 activation gate is explicitly cleared.");
        }
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        assert_eq!(
            circle.mode,
            CircleMode::Public,
            "Public distribution is public-circle only"
        );
        assert_eq!(
            circle.status,
            CircleStatus::SettlementReady,
            "All public rounds must be accumulated first"
        );
        assert!(
            circle.payout_in_flight.is_none(),
            "A payout is already in flight"
        );
        assert!(
            circle.payout_failed.is_none(),
            "Retry the failed payout before continuing"
        );

        if !circle.public_distribution_started {
            let round_total = circle
                .rounds
                .iter()
                .try_fold(0u128, |sum, round| {
                    sum.checked_add(round.total_contributed_usdc_base_units)
                })
                .expect("Public distribution total overflow");
            let mut member_total = 0u128;
            let mut already_settled_exit_total = 0u128;
            for index in 0..circle.member_count {
                let member = self
                    .member_order
                    .get(&(circle.id, index))
                    .expect("Member order entry is missing during public settlement");
                if self.is_settled_public_default_exit(circle.id, &member) {
                    let exit = self
                        .member_exits
                        .get(&(circle.id, member.clone()))
                        .expect("Settled public-default exit record is missing");
                    already_settled_exit_total = already_settled_exit_total
                        .checked_add(exit.gross_claim_usdc_base_units)
                        .expect("Settled default-exit principal total overflow");
                    continue;
                }
                let gross = self.member_total_contributions_internal(circle.id, &member);
                if gross == 0 {
                    if let Some(mut exit) = self.member_exits.get(&(circle.id, member.clone())) {
                        if exit.status == ExitSettlementStatus::PendingSettlement {
                            exit.status = ExitSettlementStatus::Settled;
                            exit.gross_claim_usdc_base_units = 0;
                            exit.penalty_basis_usdc_base_units = 0;
                            exit.penalty_bps = 0;
                            exit.penalty_usdc_base_units = 0;
                            self.member_exits
                                .insert(&(circle.id, member.clone()), &exit);
                        }
                    }
                }
                member_total = member_total
                    .checked_add(gross)
                    .expect("Public member-claim total overflow");
            }
            let remaining_round_total = round_total
                .checked_sub(already_settled_exit_total)
                .expect("Settled default exits exceed accumulated public principal");
            assert_eq!(
                member_total, remaining_round_total,
                "Unsettled member claims do not reconcile to remaining public principal"
            );
            assert!(
                member_total > 0,
                "No unsettled contribution principal remains for public distribution"
            );
            circle.public_distribution_total_usdc_base_units = member_total;
            circle.public_distribution_remaining_usdc_base_units = member_total;
            circle.public_distribution_cursor = 0;
            circle.public_distribution_started = true;
        }

        assert!(
            circle.public_distribution_remaining_usdc_base_units > 0,
            "Public distribution is already complete"
        );
        let mut selected: Option<(AccountId, u128, u32)> = None;
        while circle.public_distribution_cursor < circle.member_count {
            let index = circle.public_distribution_cursor;
            let member = self
                .member_order
                .get(&(circle.id, index))
                .expect("Member order entry is missing during public distribution");
            if self.is_settled_public_default_exit(circle.id, &member) {
                circle.public_distribution_cursor = circle
                    .public_distribution_cursor
                    .checked_add(1)
                    .expect("Public distribution cursor overflow");
                continue;
            }
            let gross = self.member_total_contributions_internal(circle.id, &member);
            if gross == 0 {
                if let Some(mut exit) = self.member_exits.get(&(circle.id, member.clone())) {
                    if exit.status == ExitSettlementStatus::PendingSettlement {
                        exit.status = ExitSettlementStatus::Settled;
                        exit.gross_claim_usdc_base_units = 0;
                        exit.penalty_basis_usdc_base_units = 0;
                        exit.penalty_bps = 0;
                        exit.penalty_usdc_base_units = 0;
                        self.member_exits.insert(&(circle.id, member), &exit);
                    }
                }
                circle.public_distribution_cursor = circle
                    .public_distribution_cursor
                    .checked_add(1)
                    .expect("Public distribution cursor overflow");
                continue;
            }
            selected = Some((member, gross, index));
            break;
        }

        let (member, gross, member_index) =
            selected.expect("Remaining public principal has no member contribution claim");
        let default_count = self.member_public_default_count(&circle, &member);
        let penalty_basis = if default_count > 0 { gross } else { 0 };
        // Every verified missed public round adds 5% of this member's own final
        // proportional contribution claim. The aggregate rate is capped at 100%;
        // the amount is then clamped to preserve a positive transfer after the
        // separate 0.5% distribution fee.
        let penalty_bps = u128::from(default_count)
            .checked_mul(PUBLIC_DEFAULT_PENALTY_BPS)
            .unwrap_or(BASIS_POINT_DENOMINATOR)
            .min(BASIS_POINT_DENOMINATOR);
        let requested_penalty = Self::basis_point_amount(penalty_basis, penalty_bps);
        let distribution_fee = Self::basis_point_amount(gross, DISTRIBUTION_FEE_BPS);
        let maximum_penalty = gross.saturating_sub(distribution_fee).saturating_sub(1);
        let penalty = requested_penalty.min(maximum_penalty);
        let transfer_amount = gross
            .checked_sub(penalty)
            .and_then(|value| value.checked_sub(distribution_fee))
            .expect("Public penalty and distribution fee exceed verified member contributions");
        assert!(
            transfer_amount > 0,
            "Net public distribution must be positive"
        );
        assert!(
            gross <= circle.public_distribution_remaining_usdc_base_units,
            "Member claim exceeds the remaining public contribution principal"
        );
        let attempt = PayoutAttempt {
            nonce: 0,
            retry_count: 0,
            kind: PayoutKind::PublicDistribution,
            round_index: 0,
            allocation_index: member_index,
            recipient: member,
            gross_amount_usdc_base_units: gross,
            penalty_amount_usdc_base_units: penalty,
            distribution_fee_usdc_base_units: distribution_fee,
            transfer_amount_usdc_base_units: transfer_amount,
        };
        self.begin_circle_payout(&mut circle, attempt)
    }

    /// A failed transfer is retried only from its stored recipient and amount. The nonce is new.
    pub fn retry_circle_payout(&mut self, circle_id: U64) -> Promise {
        self.assert_platform_sponsored();
        if !cfg!(test) {
            env::panic_str("USDC payout execution remains disabled until the Segment 3 activation gate is explicitly cleared.");
        }
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        assert!(
            circle.payout_in_flight.is_none(),
            "A payout is already in flight"
        );
        let mut attempt = circle
            .payout_failed
            .take()
            .expect("No failed payout is available to retry");
        assert!(
            attempt.retry_count < MAX_PAYOUT_RETRIES,
            "Maximum payout retries reached; manual reconciliation is required"
        );
        attempt.retry_count = attempt
            .retry_count
            .checked_add(1)
            .expect("Payout retry counter overflow");
        if attempt.kind == PayoutKind::PrivateRound {
            let round = circle
                .rounds
                .get_mut(attempt.round_index as usize)
                .expect("Failed payout round is missing");
            round.status = RoundStatus::PayoutInFlight;
        }
        self.begin_circle_payout(&mut circle, attempt)
    }

    /// The NEP-145 preflight callback. An unregistered recipient is a retryable
    /// pre-dispatch failure; a missing result remains unresolved and keeps the lock.
    #[private]
    pub fn on_circle_payout_storage_checked(
        &mut self,
        circle_id: U64,
        payout_nonce: U64,
        attempt_fingerprint: String,
    ) -> PromiseOrValue<bool> {
        assert_eq!(
            env::promise_results_count(),
            1,
            "Expected one USDC recipient storage result"
        );
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist during USDC recipient preflight");
        let attempt = circle
            .payout_in_flight
            .clone()
            .expect("No circle payout is in flight during USDC recipient preflight");
        assert_eq!(
            attempt.nonce, payout_nonce.0,
            "USDC preflight nonce mismatch"
        );
        let token_id = self.usdc_token_id.clone();
        let expected_fingerprint = Self::payout_attempt_fingerprint(circle.id, &token_id, &attempt);
        assert_eq!(
            attempt_fingerprint, expected_fingerprint,
            "USDC preflight does not match the stored transfer instruction"
        );

        match env::promise_result(0) {
            PromiseResult::Successful(bytes) => {
                let storage_balance: Option<TokenStorageBalance> =
                    near_sdk::serde_json::from_slice(&bytes).unwrap_or_else(|_| {
                        env::panic_str("USDC token returned malformed NEP-145 storage data")
                    });
                let registered = storage_balance
                    .as_ref()
                    .map(|balance| balance.total.0 > 0)
                    .unwrap_or(false);
                if !registered {
                    circle.payout_in_flight = None;
                    circle.payout_failed = Some(attempt.clone());
                    Self::restore_private_round_after_failed_payout(&mut circle, &attempt);
                    self.circles.insert(&circle.id, &circle);
                    Self::emit(
                        "circle_payout_blocked_unregistered_recipient",
                        near_sdk::serde_json::json!({
                            "circle_id": circle.id.to_string(),
                            "nonce": attempt.nonce.to_string(),
                            "retry_count": attempt.retry_count,
                            "token_id": token_id,
                            "recipient": attempt.recipient,
                            "attempt_fingerprint": expected_fingerprint,
                            "retryable": true,
                            "transfer_submitted": false
                        }),
                    );
                    return PromiseOrValue::Value(false);
                }
                let storage_balance =
                    storage_balance.expect("Registered storage balance is missing");
                Self::emit(
                    "circle_payout_recipient_registered",
                    near_sdk::serde_json::json!({
                        "circle_id": circle.id.to_string(),
                        "nonce": attempt.nonce.to_string(),
                        "retry_count": attempt.retry_count,
                        "token_id": token_id,
                        "recipient": attempt.recipient,
                        "storage_total": storage_balance.total.0.to_string(),
                        "storage_available": storage_balance.available.0.to_string(),
                        "attempt_fingerprint": expected_fingerprint
                    }),
                );

                let transfer_args = near_sdk::serde_json::json!({
                    "receiver_id": attempt.recipient,
                    "amount": attempt.transfer_amount_usdc_base_units.to_string(),
                    "memo": format!("ajocircle:{}:{}:{}", circle.id, attempt.nonce, expected_fingerprint)
                });
                let callback_args = near_sdk::serde_json::json!({
                    "circle_id": U64(circle.id),
                    "payout_nonce": U64(attempt.nonce),
                    "attempt_fingerprint": expected_fingerprint
                });
                let callback = Promise::new(env::current_account_id()).function_call(
                    "on_circle_payout_complete".to_string(),
                    callback_args.to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(PAYOUT_CALLBACK_GAS_TGAS),
                );
                let transfer = Promise::new(token_id).function_call(
                    "ft_transfer".to_string(),
                    transfer_args.to_string().into_bytes(),
                    NearToken::from_yoctonear(1),
                    Gas::from_tgas(USDC_FT_TRANSFER_GAS_TGAS),
                );
                PromiseOrValue::Promise(transfer.then(callback))
            }
            PromiseResult::Failed => {
                circle.payout_in_flight = None;
                circle.payout_failed = Some(attempt.clone());
                Self::restore_private_round_after_failed_payout(&mut circle, &attempt);
                self.circles.insert(&circle.id, &circle);
                Self::emit(
                    "circle_payout_storage_preflight_failed",
                    near_sdk::serde_json::json!({
                        "circle_id": circle.id.to_string(),
                        "nonce": attempt.nonce.to_string(),
                        "retry_count": attempt.retry_count,
                        "token_id": token_id,
                        "recipient": attempt.recipient,
                        "attempt_fingerprint": expected_fingerprint,
                        "retryable": true,
                        "transfer_submitted": false
                    }),
                );
                PromiseOrValue::Value(false)
            }
        }
    }

    /// Private, fingerprint- and nonce-bound callback. Only a successful FT transfer
    /// releases principal liability or accrues the platform distribution fee.
    #[private]
    pub fn on_circle_payout_complete(
        &mut self,
        circle_id: U64,
        payout_nonce: U64,
        attempt_fingerprint: String,
    ) -> bool {
        assert_eq!(
            env::promise_results_count(),
            1,
            "Expected one circle payout transfer result"
        );
        let mut circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        let attempt = circle
            .payout_in_flight
            .clone()
            .expect("No circle payout is in flight");
        assert_eq!(
            attempt.nonce, payout_nonce.0,
            "Circle payout callback nonce does not match"
        );
        let expected_fingerprint =
            Self::payout_attempt_fingerprint(circle.id, &self.usdc_token_id, &attempt);
        assert_eq!(
            attempt_fingerprint, expected_fingerprint,
            "Circle payout callback does not match the stored token/recipient/amount/kind"
        );
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                if attempt.kind == PayoutKind::EntryFeeRefund {
                    let mut record = self
                        .entry_fee_payments
                        .get(&(circle.id, attempt.recipient.clone()))
                        .expect("Entry-fee refund receipt is missing");
                    assert_eq!(
                        record.amount_usdc_base_units, attempt.gross_amount_usdc_base_units,
                        "Entry-fee refund amount does not match its receipt"
                    );
                    assert_eq!(
                        record.refund_at_ns, 0,
                        "Entry fee has already been refunded"
                    );
                    self.entry_fee_liability_usdc_base_units = self
                        .entry_fee_liability_usdc_base_units
                        .checked_sub(attempt.gross_amount_usdc_base_units)
                        .expect("Entry-fee liability underflow after refund");
                    record.refund_at_ns = env::block_timestamp();
                    self.entry_fee_payments
                        .insert(&(circle.id, attempt.recipient.clone()), &record);
                    if circle.entry_fee_refund_cursor >= circle.entry_fee_slot_count {
                        circle.entry_fee_refund_complete = true;
                    }
                    Self::emit(
                        "circle_entry_fee_refunded",
                        near_sdk::serde_json::json!({
                            "circle_id": circle.id.to_string(),
                            "member": attempt.recipient,
                            "amount_usdc_base_units": attempt.gross_amount_usdc_base_units.to_string(),
                            "refunded_at_ns": record.refund_at_ns.to_string(),
                            "refund_complete": circle.entry_fee_refund_complete
                        }),
                    );
                } else {
                    self.contribution_liability_usdc_base_units = self
                        .contribution_liability_usdc_base_units
                        .checked_sub(attempt.gross_amount_usdc_base_units)
                        .expect("Contribution liability underflow after payout");
                    circle.contribution_liability_usdc_base_units = circle
                        .contribution_liability_usdc_base_units
                        .checked_sub(attempt.gross_amount_usdc_base_units)
                        .expect("Circle contribution liability underflow after payout");
                    self.penalty_liability_usdc_base_units = self
                        .penalty_liability_usdc_base_units
                        .checked_add(attempt.penalty_amount_usdc_base_units)
                        .expect("Penalty liability overflow");
                    self.distribution_fee_liability_usdc_base_units = self
                        .distribution_fee_liability_usdc_base_units
                        .checked_add(attempt.distribution_fee_usdc_base_units)
                        .expect("Distribution fee liability overflow");
                }
                match attempt.kind {
                    PayoutKind::PrivateRound => {
                        assert_eq!(
                            circle.current_round, attempt.round_index,
                            "Private payout no longer matches current round"
                        );
                        let round = circle
                            .rounds
                            .get_mut(attempt.round_index as usize)
                            .expect("Private payout round is missing");
                        assert_eq!(
                            round.status,
                            RoundStatus::PayoutInFlight,
                            "Private round is not awaiting payout"
                        );
                        round.status = RoundStatus::PaidOut;
                        circle.current_round = circle
                            .current_round
                            .checked_add(1)
                            .expect("Current round overflow");
                        if circle.current_round as usize >= circle.rounds.len() {
                            circle.status = CircleStatus::Completed;
                        } else {
                            circle.rounds[circle.current_round as usize].status = RoundStatus::Open;
                        }
                    }
                    PayoutKind::PublicDistribution => {
                        assert!(
                            circle.public_distribution_started,
                            "Public distribution has not started"
                        );
                        assert_eq!(
                            circle.public_distribution_cursor, attempt.allocation_index,
                            "Public member cursor changed during transfer"
                        );
                        let expected_member = self
                            .member_order
                            .get(&(circle.id, attempt.allocation_index))
                            .expect("Public payout member-order entry is missing");
                        assert_eq!(
                            expected_member, attempt.recipient,
                            "Public payout recipient does not match the immutable member order"
                        );
                        assert_eq!(
                            self.member_total_contributions_internal(circle.id, &attempt.recipient),
                            attempt.gross_amount_usdc_base_units,
                            "Public payout gross amount does not match verified member contributions"
                        );
                        circle.public_distribution_remaining_usdc_base_units = circle
                            .public_distribution_remaining_usdc_base_units
                            .checked_sub(attempt.gross_amount_usdc_base_units)
                            .expect("Public distribution remaining amount underflow");
                        circle.public_distribution_cursor = attempt
                            .allocation_index
                            .checked_add(1)
                            .expect("Public distribution cursor overflow");
                        if circle.public_distribution_remaining_usdc_base_units == 0 {
                            circle.status = CircleStatus::Completed;
                        }
                    }
                    PayoutKind::PublicDefaultExit => {
                        assert_eq!(
                            circle.mode,
                            CircleMode::Public,
                            "Default-exit payout is public-circle only"
                        );
                        assert_eq!(
                            circle.status,
                            CircleStatus::Active,
                            "Default-exit payout requires an active circle"
                        );
                        assert!(
                            !circle.public_distribution_started,
                            "Default exit cannot overlap public distribution"
                        );
                        let exit = self
                            .member_exits
                            .get(&(circle.id, attempt.recipient.clone()))
                            .expect("Default-exit record is missing during payout callback");
                        assert_eq!(exit.reason, ExitReason::PublicDefaultRemoval);
                        assert_eq!(exit.status, ExitSettlementStatus::PendingSettlement);
                        assert_eq!(exit.source_round, attempt.round_index);
                        assert_eq!(
                            exit.gross_claim_usdc_base_units,
                            attempt.gross_amount_usdc_base_units
                        );
                        assert_eq!(
                            exit.penalty_usdc_base_units,
                            attempt.penalty_amount_usdc_base_units
                        );
                        assert_eq!(
                            attempt.distribution_fee_usdc_base_units,
                            Self::basis_point_amount(
                                attempt.gross_amount_usdc_base_units,
                                DISTRIBUTION_FEE_BPS
                            ),
                            "Default-exit distribution fee does not match policy"
                        );
                        assert_eq!(
                            attempt.transfer_amount_usdc_base_units,
                            attempt.gross_amount_usdc_base_units
                                - attempt.penalty_amount_usdc_base_units
                                - attempt.distribution_fee_usdc_base_units
                        );
                    }
                    PayoutKind::EntryFeeRefund => {
                        assert_eq!(
                            circle.status,
                            CircleStatus::Cancelled,
                            "Entry-fee refunds are valid only for cancelled circles"
                        );
                        assert!(
                            attempt.allocation_index < circle.entry_fee_refund_cursor,
                            "Entry-fee refund cursor did not advance before transfer"
                        );
                        assert_eq!(attempt.penalty_amount_usdc_base_units, 0);
                        assert_eq!(attempt.distribution_fee_usdc_base_units, 0);
                        assert_eq!(
                            attempt.transfer_amount_usdc_base_units,
                            attempt.gross_amount_usdc_base_units
                        );
                    }
                    PayoutKind::MissedContributionRefund => {
                        assert_eq!(
                            circle.status,
                            CircleStatus::Cancelled,
                            "Missed-contribution refunds require a cancelled circle"
                        );
                        assert_eq!(
                            attempt.round_index,
                            circle.current_round,
                            "Missed-contribution refund round changed"
                        );
                        assert!(
                            attempt.allocation_index < circle.cleanup_member_cursor,
                            "Missed-contribution refund cursor did not advance before transfer"
                        );
                        let expected_member = self.member_order
                            .get(&(circle.id, attempt.allocation_index))
                            .expect("Refund member order entry is missing");
                        assert_eq!(expected_member, attempt.recipient);
                        assert_eq!(attempt.penalty_amount_usdc_base_units, 0);
                        assert_eq!(attempt.distribution_fee_usdc_base_units, 0);
                        assert_eq!(
                            attempt.transfer_amount_usdc_base_units,
                            attempt.gross_amount_usdc_base_units,
                            "Missed-contribution refund must return the full held principal"
                        );
                    }
                }
                if attempt.kind != PayoutKind::EntryFeeRefund {
                    if let Some(mut exit) = self
                        .member_exits
                        .get(&(circle.id, attempt.recipient.clone()))
                    {
                        if exit.status == ExitSettlementStatus::PendingSettlement {
                            exit.status = ExitSettlementStatus::Settled;
                            if attempt.kind == PayoutKind::PublicDefaultExit {
                                assert_eq!(exit.reason, ExitReason::PublicDefaultRemoval);
                                assert_eq!(
                                    exit.gross_claim_usdc_base_units,
                                    attempt.gross_amount_usdc_base_units
                                );
                                assert_eq!(
                                    exit.penalty_usdc_base_units,
                                    attempt.penalty_amount_usdc_base_units
                                );
                                assert_eq!(
                                    exit.penalty_basis_usdc_base_units,
                                    attempt.gross_amount_usdc_base_units
                                );
                            } else {
                                exit.gross_claim_usdc_base_units =
                                    attempt.gross_amount_usdc_base_units;
                                exit.penalty_usdc_base_units =
                                    attempt.penalty_amount_usdc_base_units;
                                if attempt.kind == PayoutKind::PublicDistribution
                                    && attempt.penalty_amount_usdc_base_units > 0
                                {
                                    exit.penalty_basis_usdc_base_units = self
                                        .member_total_contributions_internal(
                                            circle.id,
                                            &attempt.recipient,
                                        );
                                    let default_count = self
                                        .member_public_default_count(&circle, &attempt.recipient);
                                    let cumulative_penalty_bps = u128::from(default_count)
                                        .checked_mul(PUBLIC_DEFAULT_PENALTY_BPS)
                                        .unwrap_or(BASIS_POINT_DENOMINATOR)
                                        .min(BASIS_POINT_DENOMINATOR);
                                    exit.penalty_bps = cumulative_penalty_bps as u16;
                                } else {
                                    exit.penalty_basis_usdc_base_units = 0;
                                    exit.penalty_bps = 0;
                                }
                            }
                            self.member_exits
                                .insert(&(circle.id, attempt.recipient.clone()), &exit);
                        }
                    }
                }
                circle.payout_in_flight = None;
                circle.payout_failed = None;
                self.circles.insert(&circle.id, &circle);
                self.assert_storage_refund_liabilities_backed();
                if attempt.kind == PayoutKind::MissedContributionRefund {
                    Self::emit(
                        "missed_contribution_principal_refunded",
                        near_sdk::serde_json::json!({
                            "circle_id": circle.id.to_string(),
                            "member": attempt.recipient,
                            "round": attempt.round_index,
                            "amount_usdc_base_units": attempt.gross_amount_usdc_base_units.to_string(),
                            "remaining_contribution_liability_usdc_base_units": circle.contribution_liability_usdc_base_units.to_string()
                        }),
                    );
                    if circle.cleanup_member_cursor >= circle.member_count
                        && circle.contribution_liability_usdc_base_units == 0
                    {
                        Self::emit(
                            "missed_contribution_principal_refunds_completed",
                            near_sdk::serde_json::json!({
                                "circle_id": circle.id.to_string(),
                                "refund_cursor": circle.cleanup_member_cursor,
                                "refund_member_count": circle.member_count,
                                "contribution_liability_usdc_base_units": "0"
                            }),
                        );
                    }
                }
                Self::emit(
                    "circle_payout_succeeded",
                    near_sdk::serde_json::json!({
                        "circle_id": circle.id.to_string(),
                        "nonce": attempt.nonce.to_string(),
                        "retry_count": attempt.retry_count,
                        "attempt_fingerprint": expected_fingerprint,
                        "token_id": self.usdc_token_id,
                        "kind": attempt.kind,
                        "round": attempt.round_index,
                        "allocation_index": attempt.allocation_index,
                        "recipient": attempt.recipient,
                        "gross_amount_usdc_base_units": attempt.gross_amount_usdc_base_units.to_string(),
                        "penalty_amount_usdc_base_units": attempt.penalty_amount_usdc_base_units.to_string(),
                        "distribution_fee_usdc_base_units": attempt.distribution_fee_usdc_base_units.to_string(),
                        "transfer_amount_usdc_base_units": attempt.transfer_amount_usdc_base_units.to_string(),
                        "next_round": circle.current_round,
                        "status": circle.status
                    }),
                );
                true
            }
            PromiseResult::Failed => {
                circle.payout_in_flight = None;
                circle.payout_failed = Some(attempt.clone());
                Self::restore_private_round_after_failed_payout(&mut circle, &attempt);
                self.circles.insert(&circle.id, &circle);
                Self::emit(
                    "circle_payout_failed",
                    near_sdk::serde_json::json!({
                        "circle_id": circle.id.to_string(),
                        "nonce": attempt.nonce.to_string(),
                        "retry_count": attempt.retry_count,
                        "attempt_fingerprint": expected_fingerprint,
                        "token_id": self.usdc_token_id,
                        "kind": attempt.kind,
                        "round": attempt.round_index,
                        "allocation_index": attempt.allocation_index,
                        "recipient": attempt.recipient,
                        "gross_amount_usdc_base_units": attempt.gross_amount_usdc_base_units.to_string(),
                        "penalty_amount_usdc_base_units": attempt.penalty_amount_usdc_base_units.to_string(),
                        "distribution_fee_usdc_base_units": attempt.distribution_fee_usdc_base_units.to_string(),
                        "transfer_amount_usdc_base_units": attempt.transfer_amount_usdc_base_units.to_string(),
                        "retryable": true
                    }),
                );
                false
            }
        }
    }

    /// Returns released NEAR storage surplus only to AjoCircle's platform treasury.
    /// No member or individual circle creator receives a NEAR storage refund.
    pub fn withdraw_storage_surplus(&mut self, circle_id: U64) -> Promise {
        self.assert_platform_sponsored();
        assert_eq!(
            env::predecessor_account_id(),
            self.owner_id,
            "Only AjoCircle's platform treasury may withdraw platform storage surplus"
        );
        let circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle is not in the active circle store");
        assert!(
            circle.status != CircleStatus::Closing && circle.status != CircleStatus::Completed,
            "Automatic cleanup owns storage refunds once a circle is closing"
        );
        let payer = self.owner_id.clone();
        let mut record = self
            .storage_deposits
            .get(&(circle_id.0, payer.clone()))
            .expect("No storage deposit exists for this payer and circle");
        assert_eq!(
            record.pending_refund_yocto, 0,
            "A storage refund is already pending"
        );
        let amount = Self::available_refund(&record);
        assert!(amount > 0, "No refundable storage surplus is available");
        self.assert_storage_refund_liabilities_backed();

        let nonce = record.next_refund_nonce;
        record.next_refund_nonce = nonce.checked_add(1).expect("Refund nonce overflow");
        record.pending_refund_nonce = nonce;
        record.pending_refund_yocto = amount;
        self.storage_deposits
            .insert(&(circle_id.0, payer.clone()), &record);

        Self::emit(
            "storage_surplus_refund_started",
            near_sdk::serde_json::json!({
                "circle_id": circle_id.0.to_string(),
                "payer": payer,
                "amount_yocto": amount.to_string(),
                "refund_nonce": nonce.to_string()
            }),
        );

        let callback_args = near_sdk::serde_json::json!({
            "circle_id": circle_id,
            "payer": payer.clone(),
            "amount": U128(amount),
            "refund_nonce": U64(nonce)
        });
        let callback = Promise::new(env::current_account_id()).function_call(
            "on_storage_deposit_refund_complete".to_string(),
            callback_args.to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(STORAGE_REFUND_CALLBACK_GAS_TGAS),
        );
        Promise::new(payer)
            .transfer(NearToken::from_yoctonear(amount))
            .then(callback)
    }

    /// Private callback. Failed transfers restore the same amount to the payer's retryable surplus.
    #[private]
    pub fn on_storage_deposit_refund_complete(
        &mut self,
        circle_id: U64,
        payer: AccountId,
        amount: U128,
        refund_nonce: U64,
    ) -> bool {
        assert_eq!(
            env::promise_results_count(),
            1,
            "Expected one refund transfer result"
        );
        let mut record = self
            .storage_deposits
            .get(&(circle_id.0, payer.clone()))
            .expect("Storage deposit record does not exist");
        assert_eq!(
            record.pending_refund_yocto, amount.0,
            "Pending storage refund amount does not match"
        );
        assert_eq!(
            record.pending_refund_nonce, refund_nonce.0,
            "Storage refund callback nonce does not match"
        );

        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                record.pending_refund_yocto = 0;
                record.refunded_yocto = record
                    .refunded_yocto
                    .checked_add(amount.0)
                    .expect("Refunded storage amount overflow");
                self.storage_refund_liability_yocto = self
                    .storage_refund_liability_yocto
                    .checked_sub(amount.0)
                    .expect("Storage refund liability underflow");
                self.storage_deposits
                    .insert(&(circle_id.0, payer.clone()), &record);
                Self::emit(
                    "storage_surplus_refund_succeeded",
                    near_sdk::serde_json::json!({
                        "circle_id": circle_id.0.to_string(),
                        "payer": payer,
                        "amount_yocto": amount.0.to_string(),
                        "refund_nonce": refund_nonce.0.to_string()
                    }),
                );
                true
            }
            _ => {
                record.pending_refund_yocto = 0;
                self.storage_deposits
                    .insert(&(circle_id.0, payer.clone()), &record);
                Self::emit(
                    "storage_surplus_refund_failed",
                    near_sdk::serde_json::json!({
                        "circle_id": circle_id.0.to_string(),
                        "payer": payer,
                        "amount_yocto": amount.0.to_string(),
                        "refund_nonce": refund_nonce.0.to_string(),
                        "retryable": true
                    }),
                );
                false
            }
        }
    }

    /// Permissionless continuation of original-payer storage refunds.
    /// Only a finalized failed callback is retryable; Pending/unknown is never resubmitted.
    pub fn continue_circle_storage_refunds(&mut self, circle_id: U64) -> PromiseOrValue<bool> {
        self.assert_platform_sponsored();
        let mut tombstone = self
            .closed_circle_tombstones
            .get(&circle_id.0)
            .expect("Circle has not completed bounded pruning");
        if tombstone.status == CircleStatus::Closed {
            return PromiseOrValue::Value(true);
        }
        assert_eq!(
            tombstone.status,
            CircleStatus::RefundingStorage,
            "Circle is not in its storage-refund phase"
        );

        if tombstone.pending_refund.status == PendingStorageRefundStatus::Pending {
            return PromiseOrValue::Value(false);
        }

        if tombstone.pending_refund.status == PendingStorageRefundStatus::Failed {
            let payer_text = std::str::from_utf8(
                &tombstone.pending_refund.payer_bytes
                    [..usize::from(tombstone.pending_refund.payer_len)],
            )
            .expect("Pending refund payer bytes are invalid UTF-8");
            let payer: AccountId = payer_text
                .parse()
                .expect("Pending refund payer account ID is invalid");
            let nonce = tombstone.next_refund_nonce;
            tombstone.next_refund_nonce =
                nonce.checked_add(1).expect("Storage refund nonce overflow");
            tombstone.pending_refund.nonce = nonce;
            tombstone.pending_refund.status = PendingStorageRefundStatus::Pending;
            self.closed_circle_tombstones
                .insert(&circle_id.0, &tombstone);
            Self::emit(
                "circle_storage_refund_retry_started",
                near_sdk::serde_json::json!({
                    "circle_id": circle_id.0.to_string(),
                    "payer": payer,
                    "amount_yocto": tombstone.pending_refund.amount_yocto.to_string(),
                    "refund_nonce": nonce.to_string()
                }),
            );
            return PromiseOrValue::Promise(Self::begin_circle_storage_refund_promise(
                circle_id.0,
                payer,
                tombstone.pending_refund.amount_yocto,
                nonce,
            ));
        }

        if tombstone.refund_cursor >= tombstone.storage_payer_count {
            if tombstone.deferred_refund_count > 0 {
                tombstone.refund_cursor = 0;
                tombstone.deferred_refund_count = 0;
                tombstone.refund_pass = tombstone
                    .refund_pass
                    .checked_add(1)
                    .expect("Storage refund pass counter overflow");
                self.closed_circle_tombstones
                    .insert(&circle_id.0, &tombstone);
                Self::emit(
                    "circle_storage_refund_pass_deferred",
                    near_sdk::serde_json::json!({
                        "circle_id": circle_id.0.to_string(),
                        "refund_pass": tombstone.refund_pass,
                        "reason": "wallet index storage is still used by another circle"
                    }),
                );
                return PromiseOrValue::Value(false);
            }
            tombstone.status = CircleStatus::Closed;
            tombstone.closed_at_ns = env::block_timestamp();
            self.closed_circle_tombstones
                .insert(&circle_id.0, &tombstone);
            Self::emit(
                "circle_closed",
                near_sdk::serde_json::json!({
                    "circle_id": circle_id.0.to_string(),
                    "closed_at_ns": tombstone.closed_at_ns.to_string(),
                    "total_storage_refunded_yocto": tombstone.total_storage_refunded_yocto.to_string(),
                    "status": "closed"
                }),
            );
            return PromiseOrValue::Value(true);
        }

        let payer_index = tombstone.refund_cursor;
        let Some(payer) = self
            .storage_deposit_payer_order
            .get(&(circle_id.0, payer_index))
        else {
            assert!(
                tombstone.refund_pass > 0,
                "Storage payer order entry is missing during the initial refund pass"
            );
            // A later deferred pass revisits earlier slots already refunded successfully
            // during the first pass. Those rows are legitimately absent; a missing row
            // before that pass has completed must never be silently skipped.
            tombstone.refund_cursor = tombstone
                .refund_cursor
                .checked_add(1)
                .expect("Storage refund cursor overflow");
            self.closed_circle_tombstones
                .insert(&circle_id.0, &tombstone);
            return PromiseOrValue::Value(false);
        };
        let record = self
            .storage_deposits
            .get(&(circle_id.0, payer.clone()))
            .expect("Storage payer ledger is missing during final refund");

        // Account-wide circle-index bytes may still be serving a different circle.
        // Keep this payer ledger until the last dependent index row is released.
        if record.shared_index_locked_yocto > 0 {
            tombstone.deferred_refund_count = tombstone
                .deferred_refund_count
                .checked_add(1)
                .expect("Deferred storage-payer counter overflow");
            tombstone.refund_cursor += 1;
            self.closed_circle_tombstones
                .insert(&circle_id.0, &tombstone);
            return PromiseOrValue::Value(false);
        }
        assert_eq!(
            record.pending_refund_yocto, 0,
            "Unexpected pending payer refund at final cleanup"
        );

        let before_storage = env::storage_usage();
        assert!(
            self.storage_deposit_payer_order
                .remove(&(circle_id.0, payer_index))
                .is_some(),
            "Storage payer order slot could not be removed"
        );
        assert!(
            self.storage_deposits
                .remove(&(circle_id.0, payer.clone()))
                .is_some(),
            "Storage payer ledger could not be removed"
        );
        let released_bytes = before_storage
            .checked_sub(env::storage_usage())
            .expect("Storage usage increased while removing the final payer ledger");
        let released_yocto = u128::from(released_bytes)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("Final payer storage release value overflow");
        let tombstone_retained = if payer == self.owner_id {
            tombstone.storage_locked_yocto
        } else {
            0
        };
        let expected_locked = released_yocto
            .checked_add(tombstone_retained)
            .expect("Expected payer storage lock overflow");
        assert_eq!(
            record.storage_locked_yocto, expected_locked,
            "Payer storage attribution mismatch: locked={} expected={} released_bytes={} tombstone_locked={} shared_index_locked={} funded_bytes={} released_bytes_recorded={} total_paid={} refunded={} payer={}",
            record.storage_locked_yocto,
            expected_locked,
            released_bytes,
            tombstone.storage_locked_yocto,
            record.shared_index_locked_yocto,
            record.storage_bytes_funded,
            record.storage_bytes_released,
            record.total_paid_yocto,
            record.refunded_yocto,
            payer
        );

        let available = Self::available_refund(&record);
        let amount = available
            .checked_add(released_yocto)
            .expect("Final storage refund amount overflow");
        assert!(amount > 0, "Final storage payer refund is zero");
        self.storage_refund_liability_yocto = self
            .storage_refund_liability_yocto
            .checked_add(released_yocto)
            .expect("Storage refund liability overflow after payer-ledger deletion");

        let nonce = tombstone.next_refund_nonce;
        tombstone.next_refund_nonce = nonce.checked_add(1).expect("Storage refund nonce overflow");
        let payer_bytes = payer.as_str().as_bytes();
        assert!(
            payer_bytes.len() <= 64,
            "NEAR account ID exceeds the fixed pending-refund payer capacity"
        );
        let mut fixed_payer = [0u8; 64];
        fixed_payer[..payer_bytes.len()].copy_from_slice(payer_bytes);
        tombstone.pending_refund = PendingStorageRefund {
            payer_bytes: fixed_payer,
            payer_len: payer_bytes.len() as u8,
            amount_yocto: amount,
            nonce,
            status: PendingStorageRefundStatus::Pending,
            kind: 2,
        };
        self.closed_circle_tombstones
            .insert(&circle_id.0, &tombstone);
        self.assert_storage_refund_liabilities_backed();
        Self::emit(
            "circle_storage_refund_started",
            near_sdk::serde_json::json!({
                "circle_id": circle_id.0.to_string(),
                "payer": payer,
                "amount_yocto": amount.to_string(),
                "released_ledger_bytes": released_bytes.to_string(),
                "refund_nonce": nonce.to_string()
            }),
        );
        PromiseOrValue::Promise(Self::begin_circle_storage_refund_promise(
            circle_id.0,
            payer,
            amount,
            nonce,
        ))
    }

    #[private]
    pub fn on_circle_storage_refund_complete(
        &mut self,
        circle_id: U64,
        payer: AccountId,
        amount: U128,
        refund_nonce: U64,
    ) -> bool {
        assert_eq!(
            env::promise_results_count(),
            1,
            "Expected one automatic circle storage refund result"
        );
        let mut tombstone = self
            .closed_circle_tombstones
            .get(&circle_id.0)
            .expect("Circle tombstone does not exist");
        let pending = tombstone.pending_refund.clone();
        assert_eq!(
            pending.status,
            PendingStorageRefundStatus::Pending,
            "No automatic storage refund is pending"
        );
        assert_eq!(
            pending.kind, 2,
            "Automatic circle refund callback kind does not match"
        );
        assert_eq!(
            pending.amount_yocto, amount.0,
            "Automatic circle refund amount does not match"
        );
        assert_eq!(
            pending.nonce, refund_nonce.0,
            "Automatic circle refund nonce does not match"
        );
        let pending_payer =
            std::str::from_utf8(&pending.payer_bytes[..usize::from(pending.payer_len)])
                .expect("Pending refund payer bytes are invalid UTF-8");
        assert_eq!(
            pending_payer,
            payer.as_str(),
            "Automatic storage refund recipient does not match original payer"
        );

        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                self.storage_refund_liability_yocto = self
                    .storage_refund_liability_yocto
                    .checked_sub(amount.0)
                    .expect("Automatic storage refund liability underflow");
                tombstone.total_storage_refunded_yocto = tombstone
                    .total_storage_refunded_yocto
                    .checked_add(amount.0)
                    .expect("Total storage refund summary overflow");
                tombstone.refund_cursor = tombstone
                    .refund_cursor
                    .checked_add(1)
                    .expect("Storage refund cursor overflow");
                tombstone.pending_refund.status = PendingStorageRefundStatus::Idle;
                tombstone.pending_refund.payer_bytes = [0u8; 64];
                tombstone.pending_refund.payer_len = 0;
                tombstone.pending_refund.amount_yocto = 0;
                tombstone.pending_refund.kind = 0;
                self.closed_circle_tombstones
                    .insert(&circle_id.0, &tombstone);
                self.assert_storage_refund_liabilities_backed();
                Self::emit(
                    "circle_storage_refund_succeeded",
                    near_sdk::serde_json::json!({
                        "circle_id": circle_id.0.to_string(),
                        "payer": payer,
                        "amount_yocto": amount.0.to_string(),
                        "refund_nonce": refund_nonce.0.to_string(),
                        "total_refunded_yocto": tombstone.total_storage_refunded_yocto.to_string()
                    }),
                );
                true
            }
            _ => {
                tombstone.pending_refund.status = PendingStorageRefundStatus::Failed;
                self.closed_circle_tombstones
                    .insert(&circle_id.0, &tombstone);
                Self::emit(
                    "circle_storage_refund_failed",
                    near_sdk::serde_json::json!({
                        "circle_id": circle_id.0.to_string(),
                        "payer": payer,
                        "amount_yocto": amount.0.to_string(),
                        "refund_nonce": refund_nonce.0.to_string(),
                        "retryable_after_confirmed_failure": true
                    }),
                );
                false
            }
        }
    }

    fn begin_circle_storage_refund_promise(
        circle_id: CircleId,
        payer: AccountId,
        amount: u128,
        nonce: u64,
    ) -> Promise {
        let args = near_sdk::serde_json::json!({
            "circle_id": U64(circle_id),
            "payer": payer.clone(),
            "amount": U128(amount),
            "refund_nonce": U64(nonce)
        });
        let callback = Promise::new(env::current_account_id()).function_call(
            "on_circle_storage_refund_complete".to_string(),
            args.to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(STORAGE_REFUND_CALLBACK_GAS_TGAS),
        );
        Promise::new(payer)
            .transfer(NearToken::from_yoctonear(amount))
            .then(callback)
    }

    pub fn get_contract_config(&self) -> ContractConfig {
        ContractConfig {
            owner_id: self.owner_id.clone(),
            usdc_token_id: self.usdc_token_id.clone(),
            usdc_symbol: "USDC".to_string(),
            usdc_decimals: USDC_DECIMALS,
            schema_version: SCHEMA_VERSION,
            next_circle_id: U64(self.next_circle_id),
            maximum_members_per_circle: MAX_MEMBERS_PER_CIRCLE,
            maximum_page_size: MAX_PAGE_SIZE,
            storage_refund_liability_yocto: U128(self.storage_refund_liability_yocto),
            contribution_liability_usdc_base_units: U128(
                self.contribution_liability_usdc_base_units,
            ),
            penalty_liability_usdc_base_units: U128(self.penalty_liability_usdc_base_units),
            entry_fee_usdc_base_units: U128(Self::configured_entry_fee_usdc_base_units()),
            distribution_fee_bps: DISTRIBUTION_FEE_BPS as u16,
            entry_fee_liability_usdc_base_units: U128(self.entry_fee_liability_usdc_base_units),
            distribution_fee_liability_usdc_base_units: U128(
                self.distribution_fee_liability_usdc_base_units,
            ),
        }
    }

    /// Mirrors the exact physical-backing calculation enforced before a storage
    /// surplus refund. This view exposes no private keys or mutation capability.
    pub fn get_contract_backing_state(&self) -> ContractBackingSummary {
        let account_balance = env::account_balance().as_yoctonear();
        let storage_usage = env::storage_usage();
        let storage_byte_cost = env::storage_byte_cost().as_yoctonear();
        let storage_stake = u128::from(storage_usage)
            .checked_mul(storage_byte_cost)
            .expect("Current storage stake calculation overflow");
        let liquid_after_storage = account_balance.saturating_sub(storage_stake);
        let protected_liabilities = self.storage_refund_liability_yocto;
        let fully_backed = liquid_after_storage >= protected_liabilities;
        ContractBackingSummary {
            account_balance_yocto: U128(account_balance),
            storage_usage_bytes: U64(storage_usage),
            storage_byte_cost_yocto: U128(storage_byte_cost),
            storage_stake_yocto: U128(storage_stake),
            liquid_after_storage_yocto: U128(liquid_after_storage),
            storage_refund_liability_yocto: U128(self.storage_refund_liability_yocto),
            contribution_liability_usdc_base_units: U128(
                self.contribution_liability_usdc_base_units,
            ),
            penalty_liability_usdc_base_units: U128(self.penalty_liability_usdc_base_units),
            entry_fee_liability_usdc_base_units: U128(self.entry_fee_liability_usdc_base_units),
            distribution_fee_liability_usdc_base_units: U128(
                self.distribution_fee_liability_usdc_base_units,
            ),
            protected_liabilities_yocto: U128(protected_liabilities),
            backing_surplus_yocto: U128(liquid_after_storage.saturating_sub(protected_liabilities)),
            fully_backed,
        }
    }

    pub fn get_entry_fee_payment(
        &self,
        circle_id: U64,
        member: AccountId,
    ) -> Option<EntryFeeSummary> {
        self.entry_fee_payments
            .get(&(circle_id.0, member.clone()))
            .filter(|record| record.amount_usdc_base_units > 0)
            .map(|record| EntryFeeSummary {
                circle_id,
                member,
                amount_usdc_base_units: U128(record.amount_usdc_base_units),
                receipt_id: encode_receipt_id(&record.receipt_id),
                paid_at_ns: U64(record.paid_at_ns),
                refunded: record.refund_at_ns > 0,
                refunded_at_ns: (record.refund_at_ns > 0).then_some(U64(record.refund_at_ns)),
            })
    }

    /// Exposes only the payout attempt fields required for independent review of
    /// a new payout or a retry. This is read-only and adds no persistent state.
    pub fn get_circle_payout_state(&self, circle_id: U64) -> Option<CirclePayoutStateSummary> {
        self.circles.get(&circle_id.0).map(|circle| {
            let summarize = |attempt: &PayoutAttempt| PayoutAttemptSummary {
                nonce: U64(attempt.nonce),
                retry_count: attempt.retry_count,
                kind: attempt.kind,
                round_index: attempt.round_index,
                allocation_index: attempt.allocation_index,
                token_id: self.usdc_token_id.clone(),
                attempt_fingerprint: Self::payout_attempt_fingerprint(
                    circle.id,
                    &self.usdc_token_id,
                    attempt,
                ),
                recipient: attempt.recipient.clone(),
                gross_amount_usdc_base_units: U128(attempt.gross_amount_usdc_base_units),
                penalty_amount_usdc_base_units: U128(attempt.penalty_amount_usdc_base_units),
                distribution_fee_usdc_base_units: U128(attempt.distribution_fee_usdc_base_units),
                transfer_amount_usdc_base_units: U128(attempt.transfer_amount_usdc_base_units),
            };
            CirclePayoutStateSummary {
                circle_id,
                next_nonce: U64(circle.payout_next_nonce),
                in_flight: circle.payout_in_flight.as_ref().map(summarize),
                failed: circle.payout_failed.as_ref().map(summarize),
            }
        })
    }

    /// Reads one immutable historical entry-fee payer index, including members
    /// who may have left before cancellation. No membership record is changed.
    pub fn get_entry_fee_payer(&self, circle_id: U64, index: u32) -> Option<EntryFeePayerSummary> {
        let circle = self.circles.get(&circle_id.0)?;
        if index >= circle.entry_fee_slot_count {
            return None;
        }
        self.entry_fee_payer_order
            .get(&(circle_id.0, index))
            .map(|member| EntryFeePayerSummary {
                circle_id,
                index,
                member,
            })
    }

    /// Bounded fallback discovery for the permissionless lifecycle keeper.
    pub fn get_cleanup_candidates(
        &self,
        from_circle_id: Option<U64>,
        limit: Option<u32>,
    ) -> Vec<CleanupCandidateSummary> {
        let start = from_circle_id.map(|id| id.0).unwrap_or(1).max(1);
        let page_limit = Self::checked_page_limit(limit);
        let end = start
            .saturating_add(u64::from(page_limit))
            .min(self.next_circle_id);
        let mut result = Vec::new();
        for id in start..end {
            if let Some(circle) = self.circles.get(&id) {
                if matches!(
                    circle.status,
                    CircleStatus::Cancelled | CircleStatus::Completed | CircleStatus::Closing
                ) {
                    result.push(CleanupCandidateSummary {
                        circle_id: U64(id),
                        status: circle.status,
                        entry_fee_refund_complete: circle.entry_fee_refund_complete
                            || circle.entry_fee_total_usdc_base_units == 0,
                        cleanup_in_progress: circle.status == CircleStatus::Closing,
                        storage_refund_pending: false,
                    });
                }
            } else if let Some(closed) = self.closed_circle_tombstones.get(&id) {
                if closed.status == CircleStatus::RefundingStorage {
                    result.push(CleanupCandidateSummary {
                        circle_id: U64(id),
                        status: closed.status,
                        entry_fee_refund_complete: true,
                        cleanup_in_progress: true,
                        storage_refund_pending: closed.pending_refund.status
                            == PendingStorageRefundStatus::Pending,
                    });
                }
            }
        }
        result
    }

    /// Compact read model for keeper recovery and cursor reconciliation.
    pub fn get_circle_cleanup_state(&self, circle_id: U64) -> Option<CircleCleanupStateSummary> {
        if let Some(circle) = self.circles.get(&circle_id.0) {
            return Some(CircleCleanupStateSummary {
                circle_id,
                status: circle.status,
                phase: format!("{:?}", circle.cleanup_stage),
                cleanup_invitation_cursor: circle.cleanup_invitation_cursor,
                cleanup_round_cursor: circle.cleanup_round_cursor,
                cleanup_member_cursor: circle.cleanup_member_cursor,
                cleanup_vote_cursor: circle.cleanup_vote_cursor,
                cleanup_entry_fee_cursor: circle.cleanup_entry_fee_cursor,
                removal_vote_count: circle.removal_vote_count,
                storage_payer_count: circle.storage_payer_count,
                refund_cursor: 0,
                deferred_refund_count: 0,
                pending_refund: false,
                pending_refund_failed: false,
                pending_refund_amount_yocto: U128(0),
                pending_refund_nonce: U64(0),
                contribution_liability_usdc_base_units: U128(
                    circle.contribution_liability_usdc_base_units,
                ),
                total_storage_refunded_yocto: U128(0),
            });
        }
        self.closed_circle_tombstones
            .get(&circle_id.0)
            .map(|closed| CircleCleanupStateSummary {
                circle_id,
                status: closed.status,
                phase: "refunding_storage".to_string(),
                cleanup_invitation_cursor: 0,
                cleanup_round_cursor: 0,
                cleanup_member_cursor: closed.original_member_count,
                cleanup_vote_cursor: 0,
                cleanup_entry_fee_cursor: 0,
                removal_vote_count: 0,
                storage_payer_count: closed.storage_payer_count,
                refund_cursor: closed.refund_cursor,
                deferred_refund_count: closed.deferred_refund_count,
                pending_refund: closed.pending_refund.status == PendingStorageRefundStatus::Pending,
                pending_refund_failed: closed.pending_refund.status
                    == PendingStorageRefundStatus::Failed,
                pending_refund_amount_yocto: U128(closed.pending_refund.amount_yocto),
                pending_refund_nonce: U64(closed.pending_refund.nonce),
                contribution_liability_usdc_base_units: U128(0),
                total_storage_refunded_yocto: U128(closed.total_storage_refunded_yocto),
            })
    }

    /// Read-only summary for the 24-hour missed-contribution cancellation path.
    pub fn get_missed_contribution_refund_state(
        &self,
        circle_id: U64,
    ) -> Option<MissedContributionRefundStateSummary> {
        self.circles.get(&circle_id.0).map(|circle| {
            let current_round = circle.rounds.get(circle.current_round as usize);
            let deadline_ns = current_round.map(|round| U64(round.deadline_ns));
            let cancellation_available_at_ns = current_round.map(|round| {
                U64(round.deadline_ns.checked_add(PUBLIC_DEFAULT_VOTE_WINDOW_NS).unwrap_or(u64::MAX))
            });
            let missed_scan_complete = current_round
                .map(|round| round.missed_scan_complete)
                .unwrap_or(false);
            let missed_count = current_round.map(|round| round.missed_count).unwrap_or(0);
            let claims = (0..circle.member_count)
                .map(|index| {
                    let member = self.member_order.get(&(circle.id, index))
                        .expect("Member order entry is missing in refund state view");
                    MissedContributionRefundClaimSummary {
                        amount_usdc_base_units: U128(
                            self.missed_contribution_refund_claim(&circle, &member),
                        ),
                        already_settled: self.is_settled_public_default_exit(circle.id, &member),
                        member,
                    }
                })
                .collect();
            let mut entry_fee_liability = 0u128;
            for index in 0..circle.entry_fee_slot_count {
                if let Some(member) = self.entry_fee_payer_order.get(&(circle.id, index)) {
                    if let Some(record) = self.entry_fee_payments.get(&(circle.id, member)) {
                        if record.refund_at_ns == 0 {
                            entry_fee_liability = entry_fee_liability
                                .checked_add(record.amount_usdc_base_units)
                                .expect("Entry-fee refund liability overflow in view");
                        }
                    }
                }
            }
            MissedContributionRefundStateSummary {
                circle_id,
                status: circle.status,
                mode: circle.mode,
                current_round: circle.current_round,
                deadline_ns,
                cancellation_available_at_ns,
                missed_scan_complete,
                missed_count,
                cancellation_eligible: self.missed_contribution_cancellation_eligible(
                    &circle,
                    env::block_timestamp(),
                ),
                refund_cursor: circle.cleanup_member_cursor,
                contribution_liability_usdc_base_units: U128(
                    circle.contribution_liability_usdc_base_units,
                ),
                entry_fee_liability_usdc_base_units: U128(entry_fee_liability),
                entry_fee_refund_complete: circle.entry_fee_refund_complete,
                payout_in_flight: circle.payout_in_flight.is_some(),
                payout_failed: circle.payout_failed.is_some(),
                claims,
            }
        })
    }

    pub fn get_circle(&self, circle_id: U64) -> Option<CircleSummary> {
        if let Some(circle) = self.circles.get(&circle_id.0) {
            return Some(Self::circle_summary(&circle));
        }
        self.closed_circle_tombstones
            .get(&circle_id.0)
            .map(|closed| CircleSummary {
                circle_id,
                creator: closed.creator.clone(),
                mode: closed.mode,
                status: closed.status,
                minimum_members: 2,
                maximum_members: closed.original_member_count.max(2),
                member_count: closed.original_member_count,
                pending_invitation_count: 0,
                invitation_expiry_cursor: 0,
                cleanup_invitation_cursor: 0,
                cleanup_member_cursor: closed.original_member_count,
                contribution_amount_usdc_base_units: U128(0),
                entry_fee_usdc_base_units: U128(0),
                entry_fee_total_usdc_base_units: U128(closed.entry_fee_total_usdc_base_units),
                entry_fee_paid_count: 0,
                entry_fee_slot_count: 0,
                entry_fee_refund_cursor: 0,
                entry_fee_refund_complete: true,
                current_round: closed.original_round_count,
                round_count: closed.original_round_count,
                current_round_deadline_ns: None,
                public_distribution_started: true,
                public_distribution_cursor: closed.original_member_count,
                public_distribution_total_usdc_base_units: U128(0),
                public_distribution_remaining_usdc_base_units: U128(0),
                payout_in_flight: false,
                payout_failed: false,
                registration_deadline_ns: U64(0),
                created_at_ns: U64(closed.created_at_ns),
                storage_deposit_yocto: U128(closed.storage_deposit_yocto),
                storage_locked_yocto: U128(closed.storage_locked_yocto),
                storage_payer_count: closed.storage_payer_count,
                closed_at_ns: (closed.closed_at_ns > 0).then_some(U64(closed.closed_at_ns)),
                total_storage_refunded_yocto: U128(closed.total_storage_refunded_yocto),
                storage_refund_cursor: closed.refund_cursor,
                storage_refund_deferred_count: closed.deferred_refund_count,
            })
    }

    pub fn get_circle_member(
        &self,
        circle_id: U64,
        account_id: AccountId,
    ) -> Option<MemberSummary> {
        if self.is_settled_public_default_exit(circle_id.0, &account_id) {
            return None;
        }
        self.members
            .get(&(circle_id.0, account_id.clone()))
            .map(|member| Self::member_summary(account_id, &member))
    }

    pub fn get_round(&self, circle_id: U64, round_index: u32) -> Option<RoundSummary> {
        let circle = self.circles.get(&circle_id.0)?;
        let round = circle.rounds.get(round_index as usize)?;
        Some(Self::round_summary(
            circle_id.0,
            round_index,
            round,
            circle.member_count,
            circle.contribution_amount_usdc_base_units,
            env::block_timestamp(),
        ))
    }

    pub fn get_current_round(&self, circle_id: U64) -> Option<RoundSummary> {
        let circle = self.circles.get(&circle_id.0)?;
        let round_index = circle.current_round;
        let round = circle.rounds.get(round_index as usize)?;
        Some(Self::round_summary(
            circle_id.0,
            round_index,
            round,
            circle.member_count,
            circle.contribution_amount_usdc_base_units,
            env::block_timestamp(),
        ))
    }

    pub fn get_rounds(
        &self,
        circle_id: U64,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<RoundSummary> {
        let circle = self
            .circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        let start = from_index.unwrap_or(0);
        let page_limit = Self::checked_page_limit(limit);
        let end = start
            .saturating_add(page_limit)
            .min(circle.rounds.len() as u32);
        let mut result = Vec::with_capacity(end.saturating_sub(start) as usize);
        for index in start..end {
            if let Some(round) = circle.rounds.get(index as usize) {
                result.push(Self::round_summary(
                    circle_id.0,
                    index,
                    round,
                    circle.member_count,
                    circle.contribution_amount_usdc_base_units,
                    env::block_timestamp(),
                ));
            }
        }
        result
    }

    pub fn get_round_contribution(
        &self,
        circle_id: U64,
        round_index: u32,
        member: AccountId,
    ) -> Option<ContributionSummary> {
        self.contributions
            .get(&(circle_id.0, round_index, member.clone()))
            .filter(|record| record.amount_usdc_base_units > 0)
            .map(|record| Self::contribution_summary(circle_id.0, round_index, member, &record))
    }

    pub fn get_missed_contribution(
        &self,
        circle_id: U64,
        round_index: u32,
        member: AccountId,
    ) -> Option<MissedContributionSummary> {
        self.missed_contributions
            .get(&(circle_id.0, round_index, member.clone()))
            .map(|record| MissedContributionSummary {
                circle_id,
                round_index,
                member: member.clone(),
                expected_amount_usdc_base_units: U128(record.expected_amount_usdc_base_units),
                deadline_ns: U64(record.deadline_ns),
                recorded_at_ns: U64(record.recorded_at_ns),
                public_default_case: self
                    .default_cases
                    .get(&(circle_id.0, round_index, member.clone()))
                    .is_some(),
            })
    }

    pub fn get_default_case(
        &self,
        circle_id: U64,
        round_index: u32,
        member: AccountId,
    ) -> Option<DefaultCaseSummary> {
        self.default_cases
            .get(&(circle_id.0, round_index, member.clone()))
            .map(|case| Self::default_case_summary(circle_id.0, round_index, member, &case))
    }

    pub fn get_removal_vote(
        &self,
        circle_id: U64,
        round_index: u32,
        target: AccountId,
        voter: AccountId,
    ) -> Option<bool> {
        self.removal_votes
            .get(&(circle_id.0, round_index, target, voter))
    }

    pub fn get_member_exit(&self, circle_id: U64, member: AccountId) -> Option<MemberExitSummary> {
        self.member_exits
            .get(&(circle_id.0, member.clone()))
            .map(|record| Self::member_exit_summary(circle_id.0, member, &record))
    }

    pub fn has_ever_defaulted(&self, circle_id: U64, member: AccountId) -> bool {
        self.ever_defaulted
            .get(&(circle_id.0, member))
            .unwrap_or(false)
    }

    /// Returns the sum of the member's verified on-contract contribution records.
    /// A circle is capped at 100 rounds, so this view has a strict upper bound.
    pub fn get_member_total_contributions(&self, circle_id: U64, member: AccountId) -> U128 {
        self.circles
            .get(&circle_id.0)
            .expect("Circle does not exist");
        U128(
            self.member_contribution_totals
                .get(&(circle_id.0, member))
                .unwrap_or(0),
        )
    }

    pub fn get_invitation_status(
        &self,
        circle_id: U64,
        invitee: AccountId,
    ) -> Option<InvitationStatus> {
        self.invitations.get(&(circle_id.0, invitee))
    }

    pub fn get_storage_deposit(
        &self,
        circle_id: U64,
        payer: AccountId,
    ) -> Option<StorageDepositSummary> {
        self.storage_deposits
            .get(&(circle_id.0, payer.clone()))
            .map(|record| Self::storage_deposit_summary(circle_id.0, payer, &record))
    }

    pub fn get_circle_storage_deposits(
        &self,
        circle_id: U64,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<StorageDepositSummary> {
        let payer_count = self
            .circles
            .get(&circle_id.0)
            .map(|circle| circle.storage_payer_count)
            .or_else(|| {
                self.closed_circle_tombstones
                    .get(&circle_id.0)
                    .map(|closed| closed.storage_payer_count)
            })
            .expect("Circle does not exist");
        let start = from_index.unwrap_or(0);
        let page_limit = Self::checked_page_limit(limit);
        let end = start.saturating_add(page_limit).min(payer_count);
        let mut result = Vec::with_capacity(end.saturating_sub(start) as usize);

        for index in start..end {
            if let Some(payer) = self.storage_deposit_payer_order.get(&(circle_id.0, index)) {
                if let Some(record) = self.storage_deposits.get(&(circle_id.0, payer.clone())) {
                    result.push(Self::storage_deposit_summary(circle_id.0, payer, &record));
                }
            }
        }
        result
    }

    pub fn get_circle_members(
        &self,
        circle_id: U64,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<MemberSummary> {
        let Some(circle) = self.circles.get(&circle_id.0) else {
            return Vec::new();
        };
        if circle.status == CircleStatus::Closing || circle.status == CircleStatus::Closed {
            return Vec::new();
        }
        let start = from_index.unwrap_or(0);
        let page_limit = Self::checked_page_limit(limit);
        let end = start.saturating_add(page_limit).min(circle.member_count);
        let mut result = Vec::with_capacity(end.saturating_sub(start) as usize);

        for index in start..end {
            if let Some(account_id) = self.member_order.get(&(circle_id.0, index)) {
                if self.is_settled_public_default_exit(circle_id.0, &account_id) {
                    continue;
                }
                if let Some(member) = self.members.get(&(circle_id.0, account_id.clone())) {
                    result.push(Self::member_summary(account_id, &member));
                }
            }
        }
        result
    }

    /// Returns a bounded page of one wallet's circle memberships.
    ///
    /// Circle membership is already public through the circle roster view. This explicit
    /// account form lets an authenticated application server query the signed-in wallet
    /// without relying on env::predecessor_account_id(), which is not the browser wallet
    /// when a backend performs a read-only call_function request.
    pub fn get_member_circles(
        &self,
        account_id: AccountId,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<CircleSummary> {
        let total = self
            .account_circle_counts
            .get(&account_id)
            .map(|record| record.count)
            .unwrap_or(0);
        let start = from_index.unwrap_or(0);
        let page_limit = Self::checked_page_limit(limit);
        let end = start.saturating_add(page_limit).min(total);
        let mut result = Vec::with_capacity(end.saturating_sub(start) as usize);

        for index in start..end {
            if let Some(circle_id) = self.member_circle_index.get(&(account_id.clone(), index)) {
                if let Some(circle) = self.circles.get(&circle_id) {
                    result.push(Self::circle_summary(&circle));
                }
            }
        }
        result
    }

    /// Backwards-compatible convenience view for direct wallet calls.
    pub fn get_my_circles(
        &self,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<CircleSummary> {
        self.get_member_circles(env::predecessor_account_id(), from_index, limit)
    }

    fn add_member(&mut self, circle: &mut Circle, account: AccountId) -> u64 {
        assert!(
            self.members.get(&(circle.id, account.clone())).is_none(),
            "Account is already a circle member"
        );
        assert!(
            circle.member_count < circle.maximum_members,
            "Circle has reached capacity"
        );

        let circle_member_index = circle.member_count;
        let prior_index_record = self.account_circle_counts.get(&account);
        let account_circle_index = prior_index_record.map(|record| record.count).unwrap_or(0);
        let funding_circle_id = prior_index_record
            .map(|record| record.funding_circle_id)
            .unwrap_or(circle.id);
        let next_account_circle_index = account_circle_index
            .checked_add(1)
            .expect("Account circle index overflow");

        self.members.insert(
            &(circle.id, account.clone()),
            &MemberRecord {
                joined_at_ns: env::block_timestamp(),
            },
        );
        if self
            .entry_fee_payments
            .get(&(circle.id, account.clone()))
            .is_none()
        {
            // The creator/joiner funds this fixed-size receipt and payer index during membership storage allocation.
            let fee_slot_index = circle.entry_fee_slot_count;
            self.entry_fee_payments
                .insert(&(circle.id, account.clone()), &EntryFeeRecord::default());
            self.entry_fee_payer_order
                .insert(&(circle.id, fee_slot_index), &account);
            circle.entry_fee_slot_count = circle
                .entry_fee_slot_count
                .checked_add(1)
                .expect("Entry-fee slot count overflow");
        }
        self.member_order
            .insert(&(circle.id, circle_member_index), &account);
        self.member_order_payers
            .insert(&(circle.id, circle_member_index), &self.owner_id);
        let before_shared_index = env::storage_usage();
        self.member_circle_index
            .insert(&(account.clone(), account_circle_index), &circle.id);
        self.member_circle_index_row_funders
            .insert(&(account.clone(), account_circle_index), &circle.id);
        self.member_circle_positions
            .insert(&(circle.id, account.clone()), &account_circle_index);
        self.account_circle_counts.insert(
            &account,
            &AccountCircleCountRecord {
                count: next_account_circle_index,
                funding_circle_id,
            },
        );
        let shared_index_bytes = env::storage_usage()
            .checked_sub(before_shared_index)
            .expect("Shared wallet index storage unexpectedly decreased");

        circle.member_count = circle
            .member_count
            .checked_add(1)
            .expect("Member count overflow");
        if circle.member_count + circle.pending_invitation_count >= circle.maximum_members {
            circle.status = CircleStatus::RegistrationClosed;
        }
        shared_index_bytes
    }

    /// Removes one account's circle index entry with swap-last compaction.
    /// The caller separately measures and credits the resulting storage release.
    fn remove_member_circle_index(
        &mut self,
        circle_id: CircleId,
        account: &AccountId,
    ) -> CircleIndexStorageRelease {
        let before_position = env::storage_usage();
        let position = self
            .member_circle_positions
            .remove(&(circle_id, account.clone()))
            .expect("Wallet circle position is missing");
        let position_bytes = before_position
            .checked_sub(env::storage_usage())
            .expect("Storage usage increased while removing a wallet circle position");

        let count_record = self
            .account_circle_counts
            .get(account)
            .expect("Wallet circle count is missing");
        let count = count_record.count;
        assert!(count > 0, "Wallet circle count underflow");
        let last_position = count - 1;
        assert!(
            position <= last_position,
            "Wallet circle position is outside its index"
        );
        let moved_circle_id = if position != last_position {
            Some(
                self.member_circle_index
                    .get(&(account.clone(), last_position))
                    .expect("Last wallet circle index entry is missing"),
            )
        } else {
            None
        };
        if let Some(moved) = moved_circle_id.as_ref() {
            assert_ne!(
                *moved, circle_id,
                "Wallet circle index contains a duplicate circle"
            );
        }

        let row_funding_circle_id = self
            .member_circle_index_row_funders
            .get(&(account.clone(), last_position))
            .expect("Wallet index row funding marker is missing");
        let before_row = env::storage_usage();
        assert!(
            self.member_circle_index
                .remove(&(account.clone(), last_position))
                .is_some(),
            "Last wallet circle index entry is missing"
        );
        assert!(
            self.member_circle_index_row_funders
                .remove(&(account.clone(), last_position))
                .is_some(),
            "Wallet index row funding marker is missing during removal"
        );
        if let Some(moved) = moved_circle_id {
            self.member_circle_index
                .insert(&(account.clone(), position), &moved);
            self.member_circle_positions
                .insert(&(moved, account.clone()), &position);
        }
        let row_bytes = before_row
            .checked_sub(env::storage_usage())
            .expect("Storage usage increased while removing a wallet circle index row");

        if last_position == 0 {
            let before_count_record = env::storage_usage();
            assert!(
                self.account_circle_counts.remove(account).is_some(),
                "Wallet circle count record is missing"
            );
            let count_record_bytes = before_count_record
                .checked_sub(env::storage_usage())
                .expect("Storage usage increased while removing final wallet circle count");
            (
                position_bytes,
                Some((row_funding_circle_id, row_bytes)),
                Some((count_record.funding_circle_id, count_record_bytes)),
            )
        } else {
            self.account_circle_counts.insert(
                account,
                &AccountCircleCountRecord {
                    count: last_position,
                    funding_circle_id: count_record.funding_circle_id,
                },
            );
            (
                position_bytes,
                Some((row_funding_circle_id, row_bytes)),
                None,
            )
        }
    }

    /// Moves storage-backed stake into this payer's withdrawable surplus after the
    /// corresponding persistent entries have actually been removed.
    fn credit_released_storage(
        &mut self,
        circle: &mut Circle,
        payer: &AccountId,
        bytes_released: u64,
    ) {
        if bytes_released == 0 {
            return;
        }

        let released_yocto = u128::from(bytes_released)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("Released storage value overflow");
        let mut record = self
            .storage_deposits
            .get(&(circle.id, payer.clone()))
            .expect("Storage payer record is missing for released bytes");
        record.storage_locked_yocto = record
            .storage_locked_yocto
            .checked_sub(released_yocto)
            .expect("Released storage exceeds this payer's locked storage");
        record.storage_bytes_released = record
            .storage_bytes_released
            .checked_add(bytes_released)
            .expect("Released storage byte counter overflow");
        assert!(
            record.storage_bytes_released <= record.storage_bytes_funded,
            "Released storage exceeds the bytes funded by this payer"
        );
        self.storage_deposits
            .insert(&(circle.id, payer.clone()), &record);

        circle.storage_locked_yocto = circle
            .storage_locked_yocto
            .checked_sub(released_yocto)
            .expect("Circle storage lock underflow during cleanup");
        self.storage_refund_liability_yocto = self
            .storage_refund_liability_yocto
            .checked_add(released_yocto)
            .expect("Global storage refund liability overflow");
    }

    fn credit_released_shared_storage(
        &mut self,
        circle: &mut Circle,
        payer: &AccountId,
        bytes_released: u64,
    ) {
        if bytes_released == 0 {
            return;
        }
        let released_yocto = u128::from(bytes_released)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("Shared index released storage value overflow");
        self.credit_released_storage(circle, payer, bytes_released);
        let mut record = self
            .storage_deposits
            .get(&(circle.id, payer.clone()))
            .expect("Shared index payer record disappeared");
        record.shared_index_locked_yocto = record
            .shared_index_locked_yocto
            .checked_sub(released_yocto)
            .expect("Shared wallet index storage lock underflow");
        self.storage_deposits
            .insert(&(circle.id, payer.clone()), &record);
    }

    fn credit_released_shared_storage_for_circle(
        &mut self,
        funding_circle_id: CircleId,
        payer: &AccountId,
        bytes_released: u64,
        current_circle: &mut Circle,
    ) {
        if bytes_released == 0 {
            return;
        }
        if funding_circle_id == current_circle.id {
            self.credit_released_shared_storage(current_circle, payer, bytes_released);
            return;
        }
        if let Some(mut funding_circle) = self.circles.get(&funding_circle_id) {
            self.credit_released_shared_storage(&mut funding_circle, payer, bytes_released);
            self.circles.insert(&funding_circle_id, &funding_circle);
            return;
        }
        if let Some(tombstone) = self.closed_circle_tombstones.get(&funding_circle_id) {
            let released_yocto = u128::from(bytes_released)
                .checked_mul(env::storage_byte_cost().as_yoctonear())
                .expect("Shared index released storage value overflow");
            let mut record = self
                .storage_deposits
                .get(&(funding_circle_id, payer.clone()))
                .expect("Original shared-index payer record is missing");
            record.storage_locked_yocto = record
                .storage_locked_yocto
                .checked_sub(released_yocto)
                .expect("Shared wallet index storage lock underflow");
            record.shared_index_locked_yocto = record
                .shared_index_locked_yocto
                .checked_sub(released_yocto)
                .expect("Shared wallet index sub-ledger underflow");
            self.storage_deposits
                .insert(&(funding_circle_id, payer.clone()), &record);
            self.closed_circle_tombstones
                .insert(&funding_circle_id, &tombstone);
            self.storage_refund_liability_yocto = self
                .storage_refund_liability_yocto
                .checked_add(released_yocto)
                .expect("Global storage refund liability overflow");
            return;
        }
        env::panic_str("Original wallet-index funding circle no longer has a storage ledger");
    }

    /// Creates one storage ledger per circle for AjoCircle's platform treasury.
    /// The member/creator is never recorded as a NEAR storage payer.
    fn prepare_platform_storage_sponsor(&mut self, circle: &mut Circle) {
        let payer = self.owner_id.clone();
        if self
            .storage_deposits
            .get(&(circle.id, payer.clone()))
            .is_none()
        {
            assert!(
                circle.storage_payer_count < MAX_STORAGE_PAYER_PER_CIRCLE,
                "Circle has reached its bounded storage-sponsor limit"
            );
            let index = circle.storage_payer_count;
            self.storage_deposit_payer_order
                .insert(&(circle.id, index), &payer);
            self.storage_deposits
                .insert(&(circle.id, payer), &StorageDepositRecord::default());
            circle.storage_payer_count = circle
                .storage_payer_count
                .checked_add(1)
                .expect("Storage sponsor count overflow");
        }
    }

    /// Allocates exact measured persistent-storage growth against AjoCircle's own
    /// pre-funded contract balance; no member or creator attaches NEAR.
    fn finish_platform_storage_growth(
        &mut self,
        circle: &mut Circle,
        before_storage: u64,
        shared_index_bytes: u64,
    ) {
        let bytes_added = env::storage_usage()
            .checked_sub(before_storage)
            .expect("Storage usage unexpectedly decreased during a sponsored operation");
        let required = u128::from(bytes_added)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("Platform storage cost calculation overflow");
        let shared_index_required = u128::from(shared_index_bytes)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("Shared wallet index storage calculation overflow");
        assert!(
            shared_index_required <= required,
            "Shared wallet index allocation exceeds measured storage growth"
        );

        let payer = self.owner_id.clone();
        let mut record = self
            .storage_deposits
            .get(&(circle.id, payer.clone()))
            .expect("AjoCircle storage sponsor record was not prepared");
        record.total_paid_yocto = record
            .total_paid_yocto
            .checked_add(required)
            .expect("Platform storage funding total overflow");
        record.storage_locked_yocto = record
            .storage_locked_yocto
            .checked_add(required)
            .expect("Platform storage lock overflow");
        record.shared_index_locked_yocto = record
            .shared_index_locked_yocto
            .checked_add(shared_index_required)
            .expect("Shared wallet index storage lock overflow");
        record.storage_bytes_funded = record
            .storage_bytes_funded
            .checked_add(bytes_added)
            .expect("Platform funded byte count overflow");
        self.storage_deposits.insert(&(circle.id, payer), &record);
        circle.storage_deposit_yocto = circle
            .storage_deposit_yocto
            .checked_add(required)
            .expect("Circle platform storage cost overflow");
        circle.storage_locked_yocto = circle
            .storage_locked_yocto
            .checked_add(required)
            .expect("Circle storage lock overflow");

        // Fail atomically when the platform contract balance cannot back the new storage.
        self.assert_storage_refund_liabilities_backed();
    }

    // Compatibility wrappers exist only for the in-memory unit-test fixtures. They
    // ignore the old per-user payer/deposit parameters and still ledger against owner_id.
    #[cfg(test)]
    fn prepare_storage_payer(&mut self, circle: &mut Circle, _former_payer: AccountId) {
        self.prepare_platform_storage_sponsor(circle);
    }
    #[cfg(test)]
    fn finish_storage_deposit(
        &mut self,
        circle: &mut Circle,
        _former_payer: &AccountId,
        _former_attached_deposit: u128,
        before_storage: u64,
        shared_index_bytes: u64,
    ) {
        self.finish_platform_storage_growth(circle, before_storage, shared_index_bytes);
    }

    fn configured_entry_fee_usdc_base_units() -> u128 {
        USDC_ENTRY_FEE_BASE_UNITS
    }

    fn record_entry_fee(
        &mut self,
        circle: &mut Circle,
        member: &AccountId,
        amount_usdc_base_units: u128,
        receipt_id: [u8; 32],
    ) -> Result<(), &'static str> {
        if amount_usdc_base_units != circle.entry_fee_usdc_base_units
            || amount_usdc_base_units != USDC_ENTRY_FEE_BASE_UNITS
        {
            return Err("Circle entry fee must be exactly 0.25 USDC");
        }
        let mut record = self
            .entry_fee_payments
            .get(&(circle.id, member.clone()))
            .ok_or("Entry-fee receipt slot was not preallocated")?;
        if record.amount_usdc_base_units != 0 || record.receipt_id != [0u8; 32] {
            return Err("Member has already paid the entry fee for this circle");
        }

        let next_circle_total = circle
            .entry_fee_total_usdc_base_units
            .checked_add(amount_usdc_base_units)
            .ok_or("Circle entry-fee total overflow")?;
        let next_paid_count = circle
            .entry_fee_paid_count
            .checked_add(1)
            .ok_or("Circle entry-fee count overflow")?;
        let next_global_liability = self
            .entry_fee_liability_usdc_base_units
            .checked_add(amount_usdc_base_units)
            .ok_or("Global USDC entry-fee liability overflow")?;

        record.amount_usdc_base_units = amount_usdc_base_units;
        record.receipt_id = receipt_id;
        record.paid_at_ns = env::block_timestamp();
        record.refund_at_ns = 0;
        self.entry_fee_payments
            .insert(&(circle.id, member.clone()), &record);
        circle.entry_fee_total_usdc_base_units = next_circle_total;
        circle.entry_fee_paid_count = next_paid_count;
        self.entry_fee_liability_usdc_base_units = next_global_liability;

        Self::emit(
            "circle_entry_fee_recorded",
            near_sdk::serde_json::json!({
                "circle_id": circle.id.to_string(),
                "member": member,
                "token_id": self.usdc_token_id,
                "amount_usdc_base_units": amount_usdc_base_units.to_string(),
                "receipt_id": encode_receipt_id(&receipt_id),
                "paid_at_ns": record.paid_at_ns.to_string(),
                "fee_usdc": "0.25"
            }),
        );
        Ok(())
    }

    fn assert_entry_fees_paid(&self, circle: &Circle) {
        for member_index in 0..circle.member_count {
            let member = self
                .member_order
                .get(&(circle.id, member_index))
                .expect("Member order entry is missing while checking entry fees");
            let paid = self
                .entry_fee_payments
                .get(&(circle.id, member))
                .map(|receipt| {
                    receipt.amount_usdc_base_units == USDC_ENTRY_FEE_BASE_UNITS
                        && receipt.receipt_id != [0u8; 32]
                })
                .unwrap_or(false);
            assert!(
                paid,
                "Every circle member must pay the 0.25 USDC entry fee before the circle starts"
            );
        }
    }

    #[cfg(test)]
    fn pay_unpaid_entry_fees_in_test(&mut self, circle: &mut Circle) {
        for member_index in 0..circle.member_count {
            let member = self
                .member_order
                .get(&(circle.id, member_index))
                .expect("Member order entry is missing while preparing test entry fees");
            let already_paid = self
                .entry_fee_payments
                .get(&(circle.id, member.clone()))
                .map(|receipt| receipt.amount_usdc_base_units == USDC_ENTRY_FEE_BASE_UNITS)
                .unwrap_or(false);
            if !already_paid {
                let receipt_id = Self::derive_usdc_receipt_id("entry_fee", circle.id, 0, &member);
                self.record_entry_fee(circle, &member, USDC_ENTRY_FEE_BASE_UNITS, receipt_id)
                    .expect("Test fixture must record exact 0.25 USDC entry fee");
            }
        }
    }
    fn is_settled_public_default_exit(&self, circle_id: CircleId, member: &AccountId) -> bool {
        self.member_exits
            .get(&(circle_id, member.clone()))
            .is_some_and(|exit| {
                exit.reason == ExitReason::PublicDefaultRemoval
                    && exit.status == ExitSettlementStatus::Settled
            })
    }

    fn active_member_count(&self, circle: &Circle) -> u32 {
        let mut count = 0u32;
        for index in 0..circle.member_count {
            let member = self
                .member_order
                .get(&(circle.id, index))
                .expect("Member order entry is missing while counting active members");
            if self.member_exits.get(&(circle.id, member)).is_none() {
                count = count.checked_add(1).expect("Active member count overflow");
            }
        }
        count
    }

    fn exclude_member_from_future_rounds(
        &self,
        circle: &mut Circle,
        member: &AccountId,
        current_round: u32,
    ) {
        for round_index in current_round.saturating_add(1)..circle.rounds.len() as u32 {
            let has_contributed = self
                .contributions
                .get(&(circle.id, round_index, member.clone()))
                .map(|record| record.amount_usdc_base_units > 0)
                .unwrap_or(false);
            if !has_contributed {
                let round = &mut circle.rounds[round_index as usize];
                if round.required_contribution_count > round.contribution_count {
                    round.required_contribution_count -= 1;
                }
            }
        }
    }

    fn has_pending_default_votes(&self, circle: &Circle, round_index: u32) -> bool {
        for index in 0..circle.member_count {
            let member = self
                .member_order
                .get(&(circle.id, index))
                .expect("Member order entry is missing while checking default votes");
            if let Some(case) = self.default_cases.get(&(circle.id, round_index, member)) {
                if case.status == DefaultCaseStatus::PendingVote {
                    return true;
                }
            }
        }
        false
    }

    /// Persists a fingerprinted payout attempt before any cross-contract promise is created.
    /// NEP-145 registration is checked first; no unregistered recipient is paid or auto-registered.
    fn begin_circle_payout(&mut self, circle: &mut Circle, mut attempt: PayoutAttempt) -> Promise {
        assert!(
            circle.payout_in_flight.is_none(),
            "A payout is already in flight"
        );
        assert!(
            circle.payout_failed.is_none(),
            "Resolve the failed payout before starting another"
        );
        assert!(
            attempt.transfer_amount_usdc_base_units > 0,
            "Payout transfer amount must be positive"
        );
        let reconciled = attempt
            .gross_amount_usdc_base_units
            .checked_sub(attempt.penalty_amount_usdc_base_units)
            .and_then(|value| value.checked_sub(attempt.distribution_fee_usdc_base_units))
            .expect("Payout deductions exceed gross amount");
        assert_eq!(
            reconciled, attempt.transfer_amount_usdc_base_units,
            "Payout attempt does not reconcile gross, penalty, fee and transfer"
        );

        let nonce = circle.payout_next_nonce;
        circle.payout_next_nonce = nonce.checked_add(1).expect("Payout nonce overflow");
        attempt.nonce = nonce;
        circle.payout_in_flight = Some(attempt.clone());
        self.circles.insert(&circle.id, circle);

        let token_id = self.usdc_token_id.clone();
        let fingerprint = Self::payout_attempt_fingerprint(circle.id, &token_id, &attempt);
        Self::emit(
            "circle_payout_started",
            near_sdk::serde_json::json!({
                "circle_id": circle.id.to_string(),
                "nonce": nonce.to_string(),
                "retry_count": attempt.retry_count,
                "attempt_fingerprint": fingerprint,
                "token_id": token_id,
                "kind": attempt.kind,
                "round": attempt.round_index,
                "allocation_index": attempt.allocation_index,
                "recipient": attempt.recipient,
                "gross_amount_usdc_base_units": attempt.gross_amount_usdc_base_units.to_string(),
                "penalty_amount_usdc_base_units": attempt.penalty_amount_usdc_base_units.to_string(),
                "distribution_fee_usdc_base_units": attempt.distribution_fee_usdc_base_units.to_string(),
                "transfer_amount_usdc_base_units": attempt.transfer_amount_usdc_base_units.to_string()
            }),
        );

        let storage_args = near_sdk::serde_json::json!({"account_id": attempt.recipient});
        let preflight = Promise::new(token_id).function_call(
            "storage_balance_of".to_string(),
            storage_args.to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(USDC_STORAGE_CHECK_GAS_TGAS),
        );
        let callback_args = near_sdk::serde_json::json!({
            "circle_id": U64(circle.id),
            "payout_nonce": U64(nonce),
            "attempt_fingerprint": fingerprint
        });
        let callback = Promise::new(env::current_account_id()).function_call(
            "on_circle_payout_storage_checked".to_string(),
            callback_args.to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(USDC_STORAGE_CALLBACK_GAS_TGAS),
        );
        preflight.then(callback)
    }

    fn restore_private_round_after_failed_payout(circle: &mut Circle, attempt: &PayoutAttempt) {
        if attempt.kind != PayoutKind::PrivateRound {
            return;
        }
        let round = circle
            .rounds
            .get_mut(attempt.round_index as usize)
            .expect("Failed private payout round is missing");
        assert_eq!(
            round.status,
            RoundStatus::PayoutInFlight,
            "Failed private payout round is not in flight"
        );
        round.status = RoundStatus::ContributionsComplete;
    }

    fn assert_storage_refund_liabilities_backed(&self) {
        let storage_stake = u128::from(env::storage_usage())
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("Current storage stake calculation overflow");
        let account_balance = env::account_balance().as_yoctonear();
        let liquid_after_storage = account_balance.saturating_sub(storage_stake);
        let protected_liabilities = self.storage_refund_liability_yocto;
        assert!(
            liquid_after_storage >= protected_liabilities,
            "Contract balance cannot cover storage refunds, contribution principal and accrued penalties without touching protected funds"
        );
    }

    fn available_refund(record: &StorageDepositRecord) -> u128 {
        record
            .total_paid_yocto
            .checked_sub(record.storage_locked_yocto)
            .and_then(|value| value.checked_sub(record.pending_refund_yocto))
            .and_then(|value| value.checked_sub(record.refunded_yocto))
            .expect("Storage deposit accounting invariant is broken")
    }

    fn checked_batch_limit(limit: Option<u32>) -> u32 {
        let value = limit.unwrap_or(MAX_DEFAULT_SCAN_BATCH);
        assert!(
            value > 0 && value <= MAX_DEFAULT_SCAN_BATCH,
            "Batch size must be between 1 and the configured maximum"
        );
        value
    }

    fn default_scan_summary(
        circle_id: CircleId,
        round_index: u32,
        round: &RoundRecord,
        processed_count: u32,
    ) -> DefaultScanSummary {
        DefaultScanSummary {
            circle_id: U64(circle_id),
            round_index,
            processed_count,
            missed_count: round.missed_count,
            next_cursor: round.missed_scan_cursor,
            complete: round.missed_scan_complete,
        }
    }

    fn member_total_contributions_internal(&self, circle_id: CircleId, member: &AccountId) -> u128 {
        self.member_contribution_totals
            .get(&(circle_id, member.clone()))
            .unwrap_or(0)
    }

    fn missed_contribution_refund_claim(&self, circle: &Circle, member: &AccountId) -> u128 {
        match circle.mode {
            CircleMode::Private => self
                .contributions
                .get(&(circle.id, circle.current_round, member.clone()))
                .map(|record| record.amount_usdc_base_units)
                .unwrap_or(0),
            CircleMode::Public if self.is_settled_public_default_exit(circle.id, member) => 0,
            CircleMode::Public => self.member_total_contributions_internal(circle.id, member),
        }
    }

    fn missed_contribution_cancellation_eligible(&self, circle: &Circle, now: u64) -> bool {
        if circle.status != CircleStatus::Active
            || circle.pending_invitation_count != 0
            || circle.payout_in_flight.is_some()
            || circle.payout_failed.is_some()
            || circle.public_distribution_started
        {
            return false;
        }
        let Some(round) = circle.rounds.get(circle.current_round as usize) else {
            return false;
        };
        let available_at = round
            .deadline_ns
            .checked_add(PUBLIC_DEFAULT_VOTE_WINDOW_NS)
            .unwrap_or(u64::MAX);
        now >= available_at
            && round.status == RoundStatus::DeadlinePassed
            && round.missed_scan_complete
            && round.missed_count > 0
            && !self.has_pending_default_votes(circle, circle.current_round)
    }

    fn member_public_default_count(&self, circle: &Circle, member: &AccountId) -> u32 {
        let mut count = 0u32;
        for round_index in 0..circle.rounds.len() as u32 {
            if self
                .missed_contributions
                .get(&(circle.id, round_index, member.clone()))
                .is_some()
            {
                count = count
                    .checked_add(1)
                    .expect("Member public-default count overflow");
            }
        }
        count
    }

    fn member_exit_claim(&self, circle: &Circle, member: &AccountId) -> (u128, u128, u16, u128) {
        let gross = self.member_total_contributions_internal(circle.id, member);
        let default_count = if circle.mode == CircleMode::Public {
            self.member_public_default_count(circle, member)
        } else {
            0
        };
        let penalty_bps = u128::from(default_count)
            .checked_mul(PUBLIC_DEFAULT_PENALTY_BPS)
            .unwrap_or(BASIS_POINT_DENOMINATOR)
            .min(BASIS_POINT_DENOMINATOR) as u16;
        let basis = if default_count > 0 { gross } else { 0 };
        let penalty = Self::basis_point_amount(basis, u128::from(penalty_bps));
        (gross, basis, penalty_bps, penalty)
    }

    /// Fingerprints every economic and routing field that a payout callback must
    /// remain bound to. Domain separation prevents reuse as another AjoCircle digest.
    fn payout_attempt_fingerprint(
        circle_id: CircleId,
        token_id: &AccountId,
        attempt: &PayoutAttempt,
    ) -> String {
        let mut payload = b"ajocircle:usdc-payout-attempt:v1".to_vec();
        payload.extend_from_slice(&circle_id.to_le_bytes());
        payload.extend_from_slice(&attempt.nonce.to_le_bytes());
        payload.extend_from_slice(&attempt.retry_count.to_le_bytes());
        payload.push(match attempt.kind {
            PayoutKind::PrivateRound => 0,
            PayoutKind::PublicDistribution => 1,
            PayoutKind::EntryFeeRefund => 2,
            PayoutKind::PublicDefaultExit => 3,
            PayoutKind::MissedContributionRefund => 4,
        });
        payload.extend_from_slice(&attempt.round_index.to_le_bytes());
        payload.extend_from_slice(&attempt.allocation_index.to_le_bytes());
        payload.extend_from_slice(&(token_id.as_bytes().len() as u32).to_le_bytes());
        payload.extend_from_slice(token_id.as_bytes());
        payload.extend_from_slice(&(attempt.recipient.as_bytes().len() as u32).to_le_bytes());
        payload.extend_from_slice(attempt.recipient.as_bytes());
        payload.extend_from_slice(&attempt.gross_amount_usdc_base_units.to_le_bytes());
        payload.extend_from_slice(&attempt.penalty_amount_usdc_base_units.to_le_bytes());
        payload.extend_from_slice(&attempt.distribution_fee_usdc_base_units.to_le_bytes());
        payload.extend_from_slice(&attempt.transfer_amount_usdc_base_units.to_le_bytes());
        let digest = env::sha256(&payload);
        let digest: [u8; 32] = digest
            .try_into()
            .expect("SHA-256 must produce an exact 32-byte payout fingerprint");
        encode_receipt_id(&digest)
    }

    fn basis_point_amount(amount: u128, bps: u128) -> u128 {
        (amount / BASIS_POINT_DENOMINATOR) * bps
            + ((amount % BASIS_POINT_DENOMINATOR) * bps) / BASIS_POINT_DENOMINATOR
    }

    fn default_case_summary(
        circle_id: CircleId,
        round_index: u32,
        member: AccountId,
        case: &DefaultCaseRecord,
    ) -> DefaultCaseSummary {
        DefaultCaseSummary {
            circle_id: U64(circle_id),
            round_index,
            member,
            status: case.status,
            vote_deadline_ns: U64(case.vote_deadline_ns),
            eligible_voter_count: case.eligible_voter_count,
            approve_count: case.approve_count,
            reject_count: case.reject_count,
            recorded_at_ns: U64(case.recorded_at_ns),
        }
    }

    fn member_exit_summary(
        circle_id: CircleId,
        member: AccountId,
        record: &MemberExitRecord,
    ) -> MemberExitSummary {
        MemberExitSummary {
            circle_id: U64(circle_id),
            member,
            reason: record.reason,
            status: record.status,
            requested_at_ns: U64(record.requested_at_ns),
            source_round: record.source_round,
            gross_claim_usdc_base_units: U128(record.gross_claim_usdc_base_units),
            penalty_basis_usdc_base_units: U128(record.penalty_basis_usdc_base_units),
            penalty_bps: record.penalty_bps,
            penalty_usdc_base_units: U128(record.penalty_usdc_base_units),
            net_claim_after_penalty_usdc_base_units: U128(
                record
                    .gross_claim_usdc_base_units
                    .checked_sub(record.penalty_usdc_base_units)
                    .expect("Exit penalty exceeds the verified contribution claim"),
            ),
        }
    }

    fn checked_page_limit(limit: Option<u32>) -> u32 {
        let value = limit.unwrap_or(20);
        assert!(
            value > 0 && value <= MAX_PAGE_SIZE,
            "Page size must be between 1 and the configured maximum"
        );
        value
    }

    fn circle_summary(circle: &Circle) -> CircleSummary {
        let current_round = circle.rounds.get(circle.current_round as usize);
        CircleSummary {
            circle_id: U64(circle.id),
            creator: circle.creator.clone(),
            mode: circle.mode,
            status: circle.status,
            minimum_members: circle.minimum_members,
            maximum_members: circle.maximum_members,
            member_count: circle.member_count,
            pending_invitation_count: circle.pending_invitation_count,
            invitation_expiry_cursor: circle.expiry_cursor,
            cleanup_invitation_cursor: circle.cleanup_invitation_cursor,
            cleanup_member_cursor: circle.cleanup_member_cursor,
            contribution_amount_usdc_base_units: U128(circle.contribution_amount_usdc_base_units),
            entry_fee_usdc_base_units: U128(circle.entry_fee_usdc_base_units),
            entry_fee_total_usdc_base_units: U128(circle.entry_fee_total_usdc_base_units),
            entry_fee_paid_count: circle.entry_fee_paid_count,
            entry_fee_slot_count: circle.entry_fee_slot_count,
            entry_fee_refund_cursor: circle.entry_fee_refund_cursor,
            entry_fee_refund_complete: circle.entry_fee_refund_complete,
            current_round: circle.current_round,
            round_count: circle.rounds.len() as u32,
            current_round_deadline_ns: current_round.map(|round| U64(round.deadline_ns)),
            public_distribution_started: circle.public_distribution_started,
            public_distribution_cursor: circle.public_distribution_cursor,
            public_distribution_total_usdc_base_units: U128(
                circle.public_distribution_total_usdc_base_units,
            ),
            public_distribution_remaining_usdc_base_units: U128(
                circle.public_distribution_remaining_usdc_base_units,
            ),
            payout_in_flight: circle.payout_in_flight.is_some(),
            payout_failed: circle.payout_failed.is_some(),
            registration_deadline_ns: U64(circle.registration_deadline_ns),
            created_at_ns: U64(circle.created_at_ns),
            storage_deposit_yocto: U128(circle.storage_deposit_yocto),
            storage_locked_yocto: U128(circle.storage_locked_yocto),
            storage_payer_count: circle.storage_payer_count,
            closed_at_ns: None,
            total_storage_refunded_yocto: U128(0),
            storage_refund_cursor: 0,
            storage_refund_deferred_count: 0,
        }
    }

    fn round_summary(
        circle_id: CircleId,
        round_index: u32,
        round: &RoundRecord,
        member_count: u32,
        contribution_amount_usdc_base_units: u128,
        now: u64,
    ) -> RoundSummary {
        let status = if round.status == RoundStatus::Open && now >= round.deadline_ns {
            RoundStatus::DeadlinePassed
        } else {
            round.status
        };
        RoundSummary {
            circle_id: U64(circle_id),
            round_index,
            deadline_ns: U64(round.deadline_ns),
            status,
            contribution_count: round.contribution_count,
            member_count,
            required_contribution_count: round.required_contribution_count,
            remaining_contributions: round
                .required_contribution_count
                .saturating_sub(round.contribution_count),
            contribution_amount_usdc_base_units: U128(contribution_amount_usdc_base_units),
            total_contributed_usdc_base_units: U128(round.total_contributed_usdc_base_units),
            missed_count: round.missed_count,
            missed_scan_cursor: round.missed_scan_cursor,
            missed_scan_complete: round.missed_scan_complete,
        }
    }

    fn contribution_summary(
        circle_id: CircleId,
        round_index: u32,
        member: AccountId,
        record: &ContributionRecord,
    ) -> ContributionSummary {
        ContributionSummary {
            circle_id: U64(circle_id),
            round_index,
            member,
            amount_usdc_base_units: U128(record.amount_usdc_base_units),
            receipt_id: encode_receipt_id(&record.receipt_id),
            contributed_at_ns: U64(record.contributed_at_ns),
            block_height: U64(record.block_height),
        }
    }

    fn member_summary(account_id: AccountId, member: &MemberRecord) -> MemberSummary {
        MemberSummary {
            account_id,
            joined_at_ns: U64(member.joined_at_ns),
        }
    }

    fn storage_deposit_summary(
        circle_id: CircleId,
        payer: AccountId,
        record: &StorageDepositRecord,
    ) -> StorageDepositSummary {
        StorageDepositSummary {
            circle_id: U64(circle_id),
            payer,
            total_paid_yocto: U128(record.total_paid_yocto),
            storage_locked_yocto: U128(record.storage_locked_yocto),
            pending_refund_yocto: U128(record.pending_refund_yocto),
            refunded_yocto: U128(record.refunded_yocto),
            available_refund_yocto: U128(Self::available_refund(record)),
            storage_bytes_funded: U64(record.storage_bytes_funded),
            storage_bytes_released: U64(record.storage_bytes_released),
            next_refund_nonce: U64(record.next_refund_nonce),
            pending_refund_nonce: U64(record.pending_refund_nonce),
            shared_index_locked_yocto: U128(record.shared_index_locked_yocto),
        }
    }

    fn emit(event: &str, data: near_sdk::serde_json::Value) {
        env::log_str(
            &near_sdk::serde_json::json!({
                "standard": "ajocircle",
                "version": "1.0.0",
                "event": event,
                "data": data
            })
            .to_string(),
        );
    }
}

#[cfg(test)]
#[allow(deprecated)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{
        get_created_receipts, testing_env_with_promise_results, VMContextBuilder,
    };
    use near_sdk::testing_env;

    const NOW: u64 = 1_000_000;
    const DEADLINE: u64 = 10_000_000;
    const TEST_ACCOUNT_BALANCE_NEAR: u128 = 1_000;

    fn account(value: &str) -> AccountId {
        value.parse().unwrap()
    }

    fn set_context(predecessor: &str, _deposit_near: u128, timestamp: u64) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(account("ajocircle.fake"))
            .signer_account_id(account("owner.testnet"))
            .predecessor_account_id(account(predecessor))
            .account_balance(NearToken::from_near(TEST_ACCOUNT_BALANCE_NEAR))
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(0))
            .block_timestamp(timestamp);
        testing_env!(builder.build());
    }

    fn set_direct_context(predecessor: &str, timestamp: u64) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(account("ajocircle.fake"))
            .signer_account_id(account(predecessor))
            .predecessor_account_id(account(predecessor))
            .account_balance(NearToken::from_near(TEST_ACCOUNT_BALANCE_NEAR))
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(0))
            .block_timestamp(timestamp);
        testing_env!(builder.build());
    }

    // Callback contexts may exhaust their mock gas allowance. Reset the context
    // without querying env::storage_usage() from that exhausted callback context.
    fn set_context_after_callback(predecessor: &str, timestamp: u64, storage_usage: u64) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(account("ajocircle.fake"))
            .signer_account_id(account("owner.testnet"))
            .predecessor_account_id(account(predecessor))
            .account_balance(NearToken::from_near(TEST_ACCOUNT_BALANCE_NEAR))
            .storage_usage(storage_usage)
            .attached_deposit(NearToken::from_yoctonear(0))
            .block_timestamp(timestamp);
        testing_env!(builder.build());
    }

    fn new_contract() -> CentralCircleContract {
        set_context("owner.testnet", 0, NOW);
        CentralCircleContract::new(account("owner.testnet"))
    }

    fn create_circle(
        contract: &mut CentralCircleContract,
        creator: &str,
        mode: CircleMode,
        maximum_members: u32,
    ) -> u64 {
        set_context(creator, 5, NOW);
        contract
            .create_circle(
                mode,
                2,
                maximum_members,
                U128(100_000_000_000_000_000_000_000),
                U64(DEADLINE),
            )
            .0
    }

    fn start_circle_for_test(
        contract: &mut CentralCircleContract,
        circle_id: u64,
        creator: &str,
        timestamp: u64,
    ) {
        let member_count = contract.get_circle(U64(circle_id)).unwrap().member_count;
        let deadlines = (0..member_count)
            .map(|index| U64(timestamp + 1_000_000_000 * u64::from(index + 1)))
            .collect();
        set_context(creator, 5, timestamp);
        contract.start_circle(U64(circle_id), deadlines);
    }

    fn usdc_contribution_message(circle_id: u64, round_index: u32) -> String {
        near_sdk::serde_json::json!({
            "version": 1,
            "action": "contribute",
            "circle_id": circle_id.to_string(),
            "round_index": round_index
        })
        .to_string()
    }

    fn usdc_entry_fee_message(circle_id: u64) -> String {
        near_sdk::serde_json::json!({
            "version": 1,
            "action": "entry_fee",
            "circle_id": circle_id.to_string(),
            "round_index": 0
        })
        .to_string()
    }

    fn unused_ft_amount(result: PromiseOrValue<U128>) -> u128 {
        match result {
            PromiseOrValue::Value(value) => value.0,
            PromiseOrValue::Promise(_) => {
                panic!("USDC contribution receiver must not create a promise")
            }
        }
    }

    #[test]
    fn contract_pins_circle_near_testnet_usdc_and_fixed_entry_fee() {
        let contract = new_contract();
        let config = contract.get_contract_config();
        assert_eq!(config.usdc_token_id, account(USDC_TOKEN_ID));
        assert_eq!(config.usdc_symbol, "USDC");
        assert_eq!(config.usdc_decimals, 6);
        assert_eq!(
            config.entry_fee_usdc_base_units.0,
            USDC_ENTRY_FEE_BASE_UNITS
        );
        assert_eq!(config.distribution_fee_bps, 50);
        assert_eq!(config.contribution_liability_usdc_base_units.0, 0);
        assert_eq!(config.penalty_liability_usdc_base_units.0, 0);
        assert_eq!(config.distribution_fee_liability_usdc_base_units.0, 0);
    }

    #[test]
    fn nep141_transfer_call_accepts_exact_member_contribution_without_member_near_deposit() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;
        let storage_before = env::storage_usage();

        set_context(USDC_TOKEN_ID, 0, NOW + 4);
        let unused = unused_ft_amount(contract.ft_on_transfer(
            account("alice.testnet"),
            U128(amount),
            usdc_contribution_message(id, 0),
        ));

        assert_eq!(
            unused, 0,
            "Accepted NEP-141 transfer must consume the exact USDC amount"
        );
        assert_eq!(
            env::storage_usage(),
            storage_before,
            "Receiver callback must not increase storage"
        );

        let contribution = contract
            .get_round_contribution(U64(id), 0, account("alice.testnet"))
            .expect("Accepted USDC receipt must be visible");
        assert_eq!(contribution.amount_usdc_base_units.0, amount);
        assert_eq!(
            contribution.receipt_id,
            encode_receipt_id(&CentralCircleContract::derive_usdc_receipt_id(
                "contribute",
                id,
                0,
                &account("alice.testnet"),
            ))
        );
        assert_eq!(
            contract.get_member_total_contributions(U64(id), account("alice.testnet")),
            U128(amount)
        );
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            amount
        );
        assert_eq!(
            contract
                .get_current_round(U64(id))
                .unwrap()
                .contribution_count,
            1
        );

        // A different message/receipt cannot make a second contribution in the same slot.
        set_context(USDC_TOKEN_ID, 0, NOW + 5);
        let duplicate_unused = unused_ft_amount(contract.ft_on_transfer(
            account("alice.testnet"),
            U128(amount),
            usdc_contribution_message(id, 0),
        ));
        assert_eq!(
            duplicate_unused, amount,
            "Duplicate contribution must be returned in full"
        );
        assert_eq!(
            contract
                .get_current_round(U64(id))
                .unwrap()
                .contribution_count,
            1
        );
    }

    #[test]
    fn nep141_receiver_refunds_wrong_amount_non_member_wrong_round_and_malformed_message() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;

        set_context(USDC_TOKEN_ID, 0, NOW + 4);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("alice.testnet"),
                U128(amount - 1),
                usdc_contribution_message(id, 0),
            )),
            amount - 1,
            "Underpayment must be returned in full"
        );

        set_context(USDC_TOKEN_ID, 0, NOW + 5);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("outsider.testnet"),
                U128(amount),
                usdc_contribution_message(id, 0),
            )),
            amount,
            "Non-member transfer must be returned in full"
        );

        set_context(USDC_TOKEN_ID, 0, NOW + 6);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("alice.testnet"),
                U128(amount),
                usdc_contribution_message(id, 1),
            )),
            amount,
            "Transfer for a non-current round must be returned in full"
        );

        set_context(USDC_TOKEN_ID, 0, NOW + 7);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("alice.testnet"),
                U128(amount),
                "{not-json".to_string(),
            )),
            amount,
            "Malformed transfer message must be returned in full"
        );
        assert!(contract
            .get_round_contribution(U64(id), 0, account("alice.testnet"))
            .is_none());
        assert_eq!(
            contract
                .get_current_round(U64(id))
                .unwrap()
                .contribution_count,
            0
        );
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            0
        );
    }

    #[test]
    fn nep141_receiver_rejects_noncanonical_token_contract() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;

        set_context("attacker.testnet", 0, NOW + 4);
        let unused = unused_ft_amount(contract.ft_on_transfer(
            account("alice.testnet"),
            U128(amount),
            usdc_contribution_message(id, 0),
        ));
        assert_eq!(unused, amount);
        assert!(contract
            .get_round_contribution(U64(id), 0, account("alice.testnet"))
            .is_none());
        assert_eq!(
            contract
                .get_current_round(U64(id))
                .unwrap()
                .contribution_count,
            0
        );
    }

    #[test]
    fn circle_entry_fee_is_exactly_025_usdc_and_paid_once_per_member() {
        let mut contract = new_contract();
        set_context("creator.testnet", 5, NOW + 1);
        let id = contract
            .create_circle(CircleMode::Public, 2, 3, U128(100_000_000), U64(DEADLINE))
            .0;
        let unpaid = contract.get_entry_fee_payment(U64(id), account("creator.testnet"));
        assert!(
            unpaid.is_none(),
            "Preallocated empty fee slot is not a paid receipt"
        );

        set_context(USDC_TOKEN_ID, 0, NOW + 2);
        let used = unused_ft_amount(contract.ft_on_transfer(
            account("creator.testnet"),
            U128(USDC_ENTRY_FEE_BASE_UNITS),
            usdc_entry_fee_message(id),
        ));
        assert_eq!(used, 0);
        let receipt = contract
            .get_entry_fee_payment(U64(id), account("creator.testnet"))
            .expect("Creator fee receipt should be recorded");
        assert_eq!(receipt.amount_usdc_base_units.0, 250_000);
        assert_eq!(
            receipt.receipt_id,
            encode_receipt_id(&CentralCircleContract::derive_usdc_receipt_id(
                "entry_fee",
                id,
                0,
                &account("creator.testnet")
            ))
        );
        assert_eq!(
            contract
                .get_contract_config()
                .entry_fee_liability_usdc_base_units
                .0,
            250_000
        );

        set_context(USDC_TOKEN_ID, 0, NOW + 3);
        let duplicate = unused_ft_amount(contract.ft_on_transfer(
            account("creator.testnet"),
            U128(USDC_ENTRY_FEE_BASE_UNITS),
            usdc_entry_fee_message(id),
        ));
        assert_eq!(
            duplicate, USDC_ENTRY_FEE_BASE_UNITS,
            "Duplicate fee must be returned"
        );
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().entry_fee_paid_count,
            1
        );
        assert_eq!(
            contract
                .get_contract_config()
                .entry_fee_liability_usdc_base_units
                .0,
            250_000
        );
    }

    #[test]
    fn circle_entry_fee_rejects_wrong_amount_non_member_and_post_start_payment() {
        let mut contract = new_contract();
        set_context("creator.testnet", 5, NOW + 1);
        let id = contract
            .create_circle(CircleMode::Public, 2, 2, U128(100_000_000), U64(DEADLINE))
            .0;

        set_context(USDC_TOKEN_ID, 0, NOW + 2);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("creator.testnet"),
                U128(250_001),
                usdc_entry_fee_message(id),
            )),
            250_001
        );
        set_context(USDC_TOKEN_ID, 0, NOW + 3);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("outsider.testnet"),
                U128(250_000),
                usdc_entry_fee_message(id),
            )),
            250_000
        );
        assert!(contract
            .get_entry_fee_payment(U64(id), account("creator.testnet"))
            .is_none());
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().entry_fee_paid_count,
            0
        );

        let active_id = setup_public_three_member_circle(&mut contract, NOW + 100);
        set_context(USDC_TOKEN_ID, 0, NOW + 104);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("alice.testnet"),
                U128(USDC_ENTRY_FEE_BASE_UNITS),
                usdc_entry_fee_message(active_id),
            )),
            USDC_ENTRY_FEE_BASE_UNITS
        );
    }

    #[test]
    fn start_circle_requires_every_current_member_to_have_paid_entry_fee() {
        let mut contract = new_contract();
        set_context("creator.testnet", 5, NOW + 1);
        let id = contract
            .create_circle(CircleMode::Public, 2, 2, U128(100_000_000), U64(DEADLINE))
            .0;
        set_context("alice.testnet", 2, NOW + 2);
        contract.join_public_circle(U64(id));
        let circle = contract.circles.get(&id).unwrap();
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.assert_entry_fees_paid(&circle)
        }))
        .is_err());
    }

    fn setup_public_three_member_circle(
        contract: &mut CentralCircleContract,
        start_timestamp: u64,
    ) -> u64 {
        let id = create_circle(contract, "creator.testnet", CircleMode::Public, 3);
        set_context("alice.testnet", 2, start_timestamp + 1);
        contract.join_public_circle(U64(id));
        set_context("bob.testnet", 2, start_timestamp + 2);
        contract.join_public_circle(U64(id));
        set_context("creator.testnet", 5, start_timestamp + 3);
        contract.start_circle(
            U64(id),
            vec![
                U64(start_timestamp + 100),
                U64(start_timestamp + 200),
                U64(start_timestamp + 300),
            ],
        );
        id
    }

    fn drive_circle_pruning_to_tombstone(
        contract: &mut CentralCircleContract,
        circle_id: u64,
        max_calls: u32,
    ) {
        for index in 0..max_calls {
            set_context("keeper.testnet", 0, NOW + 1_000 + u64::from(index));
            if contract.continue_circle_cleanup(U64(circle_id)) {
                assert!(
                    contract.closed_circle_tombstones.get(&circle_id).is_some(),
                    "Cleanup returned complete without creating a tombstone"
                );
                return;
            }
        }
        panic!("Circle pruning did not reach its tombstone within the bounded test loop");
    }

    /// Simulates finalized successful transfer receipts. Returns false when an original payer
    /// still has shared wallet-index storage used by another circle.
    fn drive_circle_storage_refunds(
        contract: &mut CentralCircleContract,
        circle_id: u64,
        max_calls: u32,
    ) -> bool {
        for index in 0..max_calls {
            set_context("keeper.testnet", 0, NOW + 2_000 + u64::from(index));
            match contract.continue_circle_storage_refunds(U64(circle_id)) {
                PromiseOrValue::Promise(_) => {
                    let tombstone = contract
                        .closed_circle_tombstones
                        .get(&circle_id)
                        .expect("Refund continuation lost its tombstone");
                    let pending = tombstone.pending_refund;
                    assert_eq!(pending.status, PendingStorageRefundStatus::Pending);
                    let payer_text =
                        std::str::from_utf8(&pending.payer_bytes[..usize::from(pending.payer_len)])
                            .expect("Pending refund payer must be UTF-8");
                    let payer: AccountId = payer_text
                        .parse()
                        .expect("Pending refund payer must be a valid account");
                    testing_env_with_promise_results(
                        callback_context(),
                        PromiseResult::Successful(Vec::new()),
                    );
                    assert!(contract.on_circle_storage_refund_complete(
                        U64(circle_id),
                        payer,
                        U128(pending.amount_yocto),
                        U64(pending.nonce),
                    ));
                }
                PromiseOrValue::Value(true) => return true,
                PromiseOrValue::Value(false) => {
                    let tombstone = contract
                        .closed_circle_tombstones
                        .get(&circle_id)
                        .expect("Refund continuation lost its tombstone");
                    if tombstone.deferred_refund_count > 0 {
                        return false;
                    }
                }
            }
        }
        contract
            .closed_circle_tombstones
            .get(&circle_id)
            .is_some_and(|tombstone| tombstone.status == CircleStatus::Closed)
    }

    fn complete_payout_for_test(
        contract: &mut CentralCircleContract,
        circle_id: u64,
        attempt: &PayoutAttempt,
    ) -> bool {
        let fingerprint = CentralCircleContract::payout_attempt_fingerprint(
            circle_id,
            &contract.usdc_token_id,
            attempt,
        );
        contract.on_circle_payout_complete(U64(circle_id), U64(attempt.nonce), fingerprint)
    }

    fn callback_context() -> near_sdk::VMContext {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(account("ajocircle.fake"))
            .signer_account_id(account("ajocircle.fake"))
            .predecessor_account_id(account("ajocircle.fake"))
            .account_balance(NearToken::from_near(TEST_ACCOUNT_BALANCE_NEAR))
            .block_timestamp(NOW + 10);
        builder.build()
    }

    #[test]
    fn creator_is_member_and_counts_toward_requested_capacity() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);

        let summary = contract.get_circle(U64(id)).unwrap();
        assert_eq!(summary.member_count, 1);
        assert_eq!(summary.maximum_members, 3);
        assert_eq!(
            contract
                .get_circle_member(U64(id), account("creator.testnet"))
                .unwrap()
                .account_id,
            account("creator.testnet")
        );
    }

    #[test]
    fn circle_ids_are_unique_and_state_is_isolated() {
        let mut contract = new_contract();
        let first = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        let second = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        assert_ne!(first, second);

        set_context("alice.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(first));

        assert_eq!(contract.get_circle(U64(first)).unwrap().member_count, 2);
        assert_eq!(contract.get_circle(U64(second)).unwrap().member_count, 1);
        assert_eq!(
            contract.get_circle_members(U64(second), None, None).len(),
            1
        );

        set_context("alice.testnet", 0, NOW + 2);
        let mine = contract.get_my_circles(None, None);
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].circle_id.0, first);

        let explicit_wallet_page =
            contract.get_member_circles(account("alice.testnet"), None, None);
        assert_eq!(explicit_wallet_page.len(), 1);
        assert_eq!(explicit_wallet_page[0].circle_id.0, first);
        let creator_page = contract.get_member_circles(account("creator.testnet"), None, Some(1));
        assert_eq!(creator_page.len(), 1);
        assert_eq!(creator_page[0].circle_id.0, first);
    }

    #[test]
    fn circle_storage_is_attributed_only_to_platform_treasury() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        let sponsor = contract
            .get_storage_deposit(U64(id), account("owner.testnet"))
            .unwrap();
        assert!(sponsor.total_paid_yocto.0 > 0);
        assert_eq!(sponsor.total_paid_yocto.0, sponsor.storage_locked_yocto.0);
        assert_eq!(sponsor.available_refund_yocto.0, 0);
        assert_eq!(
            contract.get_storage_deposit(U64(id), account("creator.testnet")),
            None
        );
        assert_eq!(
            contract
                .get_contract_config()
                .storage_refund_liability_yocto
                .0,
            0
        );
        let circle = contract.get_circle(U64(id)).unwrap();
        assert_eq!(circle.storage_payer_count, 1);
        assert_eq!(circle.storage_deposit_yocto, sponsor.total_paid_yocto);
    }
    #[test]
    fn member_and_invitation_storage_are_all_attributed_to_ajo_platform() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Private, 3);
        let before = contract
            .get_storage_deposit(U64(id), account("owner.testnet"))
            .unwrap();
        set_context("creator.testnet", 0, NOW + 1);
        contract.invite_private_member(U64(id), account("invitee.testnet"));
        let after_invite = contract
            .get_storage_deposit(U64(id), account("owner.testnet"))
            .unwrap();
        assert!(after_invite.total_paid_yocto.0 > before.total_paid_yocto.0);
        assert_eq!(
            contract.get_storage_deposit(U64(id), account("creator.testnet")),
            None
        );
        set_context("invitee.testnet", 0, NOW + 2);
        contract.accept_private_invitation(U64(id));
        let after_accept = contract
            .get_storage_deposit(U64(id), account("owner.testnet"))
            .unwrap();
        assert!(after_accept.total_paid_yocto.0 > after_invite.total_paid_yocto.0);
        assert_eq!(
            contract.get_storage_deposit(U64(id), account("invitee.testnet")),
            None
        );
        assert_eq!(contract.get_circle(U64(id)).unwrap().storage_payer_count, 1);
    }
    #[test]
    fn platform_storage_is_not_refunded_before_temporary_records_are_removed() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        let before = contract
            .get_storage_deposit(U64(id), account("owner.testnet"))
            .unwrap();
        assert_eq!(before.available_refund_yocto.0, 0);
        let liability_before = contract.storage_refund_liability_yocto;
        set_context("owner.testnet", 0, NOW + 1);
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.withdraw_storage_surplus(U64(id))
        }));
        assert!(
            attempt.is_err(),
            "Locked platform storage cannot be withdrawn before cleanup"
        );
        let after = contract
            .get_storage_deposit(U64(id), account("owner.testnet"))
            .unwrap();
        assert_eq!(after.pending_refund_yocto.0, 0);
        assert_eq!(after.refunded_yocto.0, 0);
        assert_eq!(contract.storage_refund_liability_yocto, liability_before);
    }
    #[test]
    fn failed_platform_storage_refund_is_retryable_after_cleanup() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        set_context("creator.testnet", 0, NOW + 1);
        contract.cancel_unstarted_circle(U64(id));
        drive_circle_pruning_to_tombstone(&mut contract, id, 100);
        set_context("keeper.testnet", 0, NOW + 2);
        let _promise = contract.continue_circle_storage_refunds(U64(id));
        let pending = contract
            .closed_circle_tombstones
            .get(&id)
            .unwrap()
            .pending_refund;
        assert_eq!(pending.status, PendingStorageRefundStatus::Pending);
        let payer_text =
            std::str::from_utf8(&pending.payer_bytes[..usize::from(pending.payer_len)]).unwrap();
        assert_eq!(payer_text, "owner.testnet");
        let liability_before = contract.storage_refund_liability_yocto;
        testing_env_with_promise_results(callback_context(), PromiseResult::Failed);
        assert!(!contract.on_circle_storage_refund_complete(
            U64(id),
            account("owner.testnet"),
            U128(pending.amount_yocto),
            U64(pending.nonce)
        ));
        assert_eq!(contract.storage_refund_liability_yocto, liability_before);
        assert_eq!(
            contract
                .closed_circle_tombstones
                .get(&id)
                .unwrap()
                .pending_refund
                .status,
            PendingStorageRefundStatus::Failed
        );
        set_context("keeper.testnet", 0, NOW + 3);
        let _retry = contract.continue_circle_storage_refunds(U64(id));
        let retry_pending = contract
            .closed_circle_tombstones
            .get(&id)
            .unwrap()
            .pending_refund;
        assert_eq!(retry_pending.status, PendingStorageRefundStatus::Pending);
        assert!(retry_pending.nonce > pending.nonce);
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(contract.on_circle_storage_refund_complete(
            U64(id),
            account("owner.testnet"),
            U128(retry_pending.amount_yocto),
            U64(retry_pending.nonce)
        ));
    }
    #[test]
    #[should_panic(
        expected = "Only AjoCircle's platform treasury may withdraw platform storage surplus"
    )]
    fn another_wallet_cannot_withdraw_platform_storage_surplus() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        set_context("attacker.testnet", 0, NOW + 1);
        let _promise = contract.withdraw_storage_surplus(U64(id));
    }
    #[test]
    fn direct_creator_call_cannot_bypass_platform_near_sponsorship() {
        let mut contract = new_contract();
        set_direct_context("creator.testnet", NOW);
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.create_circle(
                CircleMode::Public,
                2,
                3,
                U128(100_000_000_000_000_000_000_000),
                U64(DEADLINE),
            )
        }));
        assert!(
            attempt.is_err(),
            "A direct creator transaction must not pay NEAR"
        );
        assert_eq!(contract.next_circle_id, 1);
    }
    #[test]
    fn creator_can_revoke_and_reissue_a_private_invitation() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Private, 2);

        set_context("creator.testnet", 2, NOW + 1);
        contract.invite_private_member(U64(id), account("invitee.testnet"));
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().status,
            CircleStatus::RegistrationClosed
        );

        set_context("creator.testnet", 0, NOW + 2);
        contract.revoke_private_invitation(U64(id), account("invitee.testnet"));
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().status,
            CircleStatus::RegistrationOpen
        );
        assert_eq!(
            contract.get_invitation_status(U64(id), account("invitee.testnet")),
            Some(InvitationStatus::Revoked)
        );

        set_context("creator.testnet", 2, NOW + 3);
        contract.invite_private_member(U64(id), account("invitee.testnet"));
        assert_eq!(
            contract.get_invitation_status(U64(id), account("invitee.testnet")),
            Some(InvitationStatus::Pending)
        );
        assert_eq!(
            contract
                .get_circle(U64(id))
                .unwrap()
                .pending_invitation_count,
            1
        );

        set_context("invitee.testnet", 2, NOW + 4);
        contract.accept_private_invitation(U64(id));
        assert_eq!(contract.get_circle(U64(id)).unwrap().member_count, 2);
    }

    #[test]
    fn cancellation_freezes_circle_and_preserves_platform_storage_audit() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        set_context("creator.testnet", 0, NOW + 1);
        contract.cancel_unstarted_circle(U64(id));
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().status,
            CircleStatus::Cancelled
        );
        assert!(contract
            .get_storage_deposit(U64(id), account("owner.testnet"))
            .is_some());
        assert_eq!(
            contract.get_storage_deposit(U64(id), account("creator.testnet")),
            None
        );
    }
    #[test]
    fn cancelled_circle_cleanup_returns_all_near_storage_to_platform_treasury() {
        let mut contract = new_contract();
        let cancelled_id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        set_context("alice.testnet", 0, NOW + 1);
        contract.join_public_circle(U64(cancelled_id));
        let other_id = create_circle(&mut contract, "alice.testnet", CircleMode::Public, 2);
        set_context("creator.testnet", 0, NOW + 3);
        contract.cancel_unstarted_circle(U64(cancelled_id));
        drive_circle_pruning_to_tombstone(&mut contract, cancelled_id, 100);
        let refunding = contract.get_circle(U64(cancelled_id)).unwrap();
        assert_eq!(refunding.status, CircleStatus::RefundingStorage);
        assert_eq!(refunding.member_count, 2);
        assert!(contract
            .get_circle_members(U64(cancelled_id), None, None)
            .is_empty());
        let sponsor_record = contract
            .get_storage_deposit(U64(cancelled_id), account("owner.testnet"))
            .unwrap();
        assert!(
            sponsor_record.shared_index_locked_yocto.0 > 0,
            "Shared wallet index is still used by Alice's second circle"
        );
        assert_eq!(
            contract.get_storage_deposit(U64(cancelled_id), account("alice.testnet")),
            None
        );
        assert_eq!(
            contract.get_storage_deposit(U64(cancelled_id), account("creator.testnet")),
            None
        );
        assert!(
            !drive_circle_storage_refunds(&mut contract, cancelled_id, 50),
            "Refund must be deferred while shared account index storage is still in use"
        );
        set_context("alice.testnet", 0, NOW + 6);
        contract.cancel_unstarted_circle(U64(other_id));
        drive_circle_pruning_to_tombstone(&mut contract, other_id, 100);
        assert!(drive_circle_storage_refunds(&mut contract, other_id, 50));
        assert!(drive_circle_storage_refunds(
            &mut contract,
            cancelled_id,
            100
        ));
        assert_eq!(
            contract.get_circle(U64(cancelled_id)).unwrap().status,
            CircleStatus::Closed
        );
        assert_eq!(
            contract.get_circle(U64(other_id)).unwrap().status,
            CircleStatus::Closed
        );
        assert_eq!(
            contract
                .get_circle(U64(cancelled_id))
                .unwrap()
                .storage_payer_count,
            1
        );
        assert_eq!(
            contract
                .get_circle(U64(other_id))
                .unwrap()
                .storage_payer_count,
            1
        );
    }
    #[test]
    fn missing_platform_storage_payer_order_slot_fails_closed_without_advancing_refund_cursor() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context("creator.testnet", 0, NOW + 1);
        contract.cancel_unstarted_circle(U64(id));
        drive_circle_pruning_to_tombstone(&mut contract, id, 100);
        let payer = contract.storage_deposit_payer_order.get(&(id, 0)).unwrap();
        assert_eq!(payer, account("owner.testnet"));
        let liability_before = contract.storage_refund_liability_yocto;
        assert!(contract
            .storage_deposits
            .get(&(id, payer.clone()))
            .is_some());
        assert!(contract
            .storage_deposit_payer_order
            .remove(&(id, 0))
            .is_some());
        set_context("keeper.testnet", 0, NOW + 2);
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.continue_circle_storage_refunds(U64(id))
        }));
        assert!(
            attempt.is_err(),
            "A missing platform payer index must fail closed"
        );
        let tombstone = contract.closed_circle_tombstones.get(&id).unwrap();
        assert_eq!(tombstone.status, CircleStatus::RefundingStorage);
        assert_eq!(tombstone.refund_cursor, 0);
        assert_eq!(contract.storage_refund_liability_yocto, liability_before);
        assert!(contract.storage_deposits.get(&(id, payer)).is_some());
    }
    #[test]
    fn cleanup_vote_order_index_and_vote_record_are_credited_to_platform_sponsor() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        let voter = account("voter.testnet");
        let target = account("target.testnet");
        let mut circle = contract.circles.get(&id).unwrap();
        let before_storage = env::storage_usage();
        contract.prepare_storage_payer(&mut circle, voter.clone());
        contract.removal_vote_order.insert(
            &(id, 0),
            &RemovalVoteKey {
                round_index: 0,
                target: target.clone(),
                voter: voter.clone(),
            },
        );
        contract
            .removal_votes
            .insert(&(id, 0, target, voter.clone()), &true);
        contract.circles.insert(&id, &circle);
        contract.finish_storage_deposit(&mut circle, &voter, 0, before_storage, 0);
        circle.removal_vote_count = 1;
        contract.circles.insert(&id, &circle);
        set_context("creator.testnet", 0, NOW + 1);
        contract.cancel_unstarted_circle(U64(id));
        drive_circle_pruning_to_tombstone(&mut contract, id, 100);
        assert!(drive_circle_storage_refunds(&mut contract, id, 100));
        let tombstone = contract.closed_circle_tombstones.get(&id).unwrap();
        assert_eq!(tombstone.status, CircleStatus::Closed);
        assert_eq!(tombstone.refund_cursor, tombstone.storage_payer_count);
    }
    #[test]
    fn private_invitation_cleanup_is_bounded_and_refunds_ajo_platform() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Private, 100);
        for index in 0..26u32 {
            let invitee: AccountId = format!("inv{:03}.testnet", index).parse().unwrap();
            set_context("creator.testnet", 0, NOW + u64::from(index) + 1);
            contract.invite_private_member(U64(id), invitee.clone());
            set_context("creator.testnet", 0, NOW + u64::from(index) + 2);
            contract.revoke_private_invitation(U64(id), invitee);
        }
        let before = contract
            .get_storage_deposit(U64(id), account("owner.testnet"))
            .unwrap();
        set_context("creator.testnet", 0, NOW + 100);
        contract.cancel_unstarted_circle(U64(id));
        set_context("keeper.testnet", 0, NOW + 101);
        assert!(!contract.continue_circle_cleanup(U64(id)));
        let first_batch = contract.get_circle(U64(id)).unwrap();
        assert_eq!(first_batch.status, CircleStatus::Closing);
        assert_eq!(first_batch.cleanup_invitation_cursor, 25);
        assert_eq!(first_batch.cleanup_member_cursor, 0);
        assert_eq!(
            contract.get_invitation_status(U64(id), account("inv000.testnet")),
            None
        );
        assert_eq!(
            contract.get_invitation_status(U64(id), account("inv025.testnet")),
            Some(InvitationStatus::Revoked)
        );
        drive_circle_pruning_to_tombstone(&mut contract, id, 100);
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().status,
            CircleStatus::RefundingStorage
        );
        assert!(drive_circle_storage_refunds(&mut contract, id, 50));
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().status,
            CircleStatus::Closed
        );
        assert!(before.total_paid_yocto.0 > 0);
        assert_eq!(
            contract.get_storage_deposit(U64(id), account("owner.testnet")),
            None
        );
        assert_eq!(
            contract.get_storage_deposit(U64(id), account("owner.testnet")),
            None
        );
    }
    #[test]
    #[should_panic(expected = "Only cancelled or fully completed circles may be cleaned up")]
    fn active_circle_cannot_enter_registration_storage_cleanup() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context("member.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        start_circle_for_test(&mut contract, id, "creator.testnet", NOW + 2);
        set_context("anyone.testnet", 0, NOW + 3);
        contract.continue_circle_cleanup(U64(id));
    }

    #[test]
    fn starting_circle_freezes_one_strictly_increasing_deadline_per_member() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        set_context("alice.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        set_context("bob.testnet", 2, NOW + 2);
        contract.join_public_circle(U64(id));

        let deadlines = vec![U64(NOW + 100), U64(NOW + 200), U64(NOW + 300)];
        set_context("creator.testnet", 5, NOW + 3);
        contract.start_circle(U64(id), deadlines.clone());

        let rounds = contract.get_rounds(U64(id), None, None);
        assert_eq!(rounds.len(), 3);
        assert_eq!(rounds[0].status, RoundStatus::Open);
        assert_eq!(rounds[1].status, RoundStatus::Scheduled);
        assert_eq!(rounds[2].status, RoundStatus::Scheduled);
        assert_eq!(rounds[0].deadline_ns, deadlines[0]);
        assert_eq!(rounds[1].deadline_ns, deadlines[1]);
        assert_eq!(rounds[2].deadline_ns, deadlines[2]);
        let summary = contract.get_circle(U64(id)).unwrap();
        assert_eq!(summary.current_round, 0);
        assert_eq!(summary.round_count, 3);
        assert_eq!(summary.current_round_deadline_ns, Some(deadlines[0]));
        assert!(
            contract
                .get_storage_deposit(U64(id), account("owner.testnet"))
                .unwrap()
                .storage_bytes_funded
                .0
                > 0
        );
    }

    #[test]
    fn contributions_are_wallet_bound_exact_and_round_scoped() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        set_context("alice.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        set_context("bob.testnet", 2, NOW + 2);
        contract.join_public_circle(U64(id));

        set_context("creator.testnet", 5, NOW + 3);
        contract.start_circle(
            U64(id),
            vec![U64(NOW + 100), U64(NOW + 200), U64(NOW + 300)],
        );

        let contribution_amount = 100_000_000_000_000_000_000_000u128;
        let alice_storage_before = contract
            .get_storage_deposit(U64(id), account("owner.testnet"))
            .unwrap()
            .total_paid_yocto
            .0;
        set_context("alice.testnet", 1, NOW + 4);
        contract.contribute(U64(id));

        let alice_contribution = contract
            .get_round_contribution(U64(id), 0, account("alice.testnet"))
            .unwrap();
        assert_eq!(
            alice_contribution.amount_usdc_base_units.0,
            contribution_amount
        );
        assert_eq!(alice_contribution.contributed_at_ns.0, NOW + 4);
        assert_eq!(
            contract.get_member_total_contributions(U64(id), account("alice.testnet")),
            U128(contribution_amount)
        );
        let alice_storage_after = contract
            .get_storage_deposit(U64(id), account("owner.testnet"))
            .unwrap();
        assert_eq!(alice_storage_after.total_paid_yocto.0, alice_storage_before);
        assert_eq!(
            contract.get_storage_deposit(U64(id), account("alice.testnet")),
            None
        );
        let creator_storage = contract
            .get_storage_deposit(U64(id), account("owner.testnet"))
            .unwrap();
        assert!(creator_storage.storage_bytes_funded.0 > 0);

        let after_alice = contract.get_current_round(U64(id)).unwrap();
        assert_eq!(after_alice.contribution_count, 1);
        assert_eq!(
            after_alice.total_contributed_usdc_base_units.0,
            contribution_amount
        );
        assert_eq!(after_alice.remaining_contributions, 2);

        set_context("bob.testnet", 1, NOW + 5);
        contract.contribute(U64(id));
        set_context("creator.testnet", 1, NOW + 6);
        contract.contribute(U64(id));

        let completed = contract.get_current_round(U64(id)).unwrap();
        assert_eq!(completed.status, RoundStatus::ContributionsComplete);
        assert_eq!(completed.contribution_count, 3);
        assert_eq!(
            completed.total_contributed_usdc_base_units.0,
            contribution_amount * 3
        );
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            contribution_amount * 3
        );

        let duplicate = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.contribute(U64(id))
        }));
        assert!(
            duplicate.is_err(),
            "A wallet cannot contribute twice in one round"
        );
    }

    #[test]
    fn contribution_below_the_fixed_usdc_principal_is_refunded() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;
        set_context(USDC_TOKEN_ID, 0, NOW + 4);
        let unused = unused_ft_amount(contract.ft_on_transfer(
            account("alice.testnet"),
            U128(amount - 1),
            usdc_contribution_message(id, 0),
        ));
        assert_eq!(unused, amount - 1);
        assert_eq!(
            contract
                .get_current_round(U64(id))
                .unwrap()
                .contribution_count,
            0
        );
    }
    #[test]
    fn member_contribution_receipt_uses_preallocated_storage_without_member_near_deposit() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;
        let storage_before = env::storage_usage();
        set_context(USDC_TOKEN_ID, 0, NOW + 4);
        let unused = unused_ft_amount(contract.ft_on_transfer(
            account("alice.testnet"),
            U128(amount),
            usdc_contribution_message(id, 0),
        ));
        assert_eq!(unused, 0);
        assert_eq!(env::storage_usage(), storage_before);
    }
    #[test]
    #[should_panic(expected = "Sender is not a member of this circle")]
    fn non_member_cannot_contribute_to_a_circle() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context("member.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        start_circle_for_test(&mut contract, id, "creator.testnet", NOW + 2);
        set_context("outsider.testnet", 1, NOW + 3);
        contract.contribute(U64(id));
    }

    #[test]
    #[should_panic(expected = "Contribution deadline has passed")]
    fn contribution_is_rejected_at_or_after_its_immutable_deadline() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context("member.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        set_context("creator.testnet", 5, NOW + 2);
        contract.start_circle(U64(id), vec![U64(NOW + 10), U64(NOW + 20)]);
        set_context("member.testnet", 1, NOW + 10);
        contract.contribute(U64(id));
    }

    #[test]
    fn current_round_view_reports_deadline_passed_without_mutating_schedule() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context("member.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        set_context("creator.testnet", 5, NOW + 2);
        contract.start_circle(U64(id), vec![U64(NOW + 10), U64(NOW + 20)]);

        set_context("reader.testnet", 0, NOW + 10);
        let current = contract.get_current_round(U64(id)).unwrap();
        assert_eq!(current.status, RoundStatus::DeadlinePassed);
        assert_eq!(current.deadline_ns, U64(NOW + 10));
        let future = contract.get_round(U64(id), 1).unwrap();
        assert_eq!(future.status, RoundStatus::Scheduled);
        assert_eq!(future.deadline_ns, U64(NOW + 20));
        assert_eq!(
            contract
                .get_circle(U64(id))
                .unwrap()
                .current_round_deadline_ns,
            Some(U64(NOW + 10))
        );
    }

    #[test]
    #[should_panic(expected = "Round deadlines must be strictly increasing")]
    fn start_circle_rejects_non_increasing_deadlines() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context("member.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        set_context("creator.testnet", 5, NOW + 2);
        contract.start_circle(U64(id), vec![U64(NOW + 20), U64(NOW + 20)]);
    }

    #[test]
    #[should_panic(expected = "Schedule must contain exactly one deadline per active member")]
    fn start_circle_rejects_a_schedule_with_the_wrong_round_count() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context("member.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        set_context("creator.testnet", 5, NOW + 2);
        contract.start_circle(U64(id), vec![U64(NOW + 20)]);
    }

    #[test]
    #[should_panic(expected = "Round is not accepting contributions")]
    fn later_scheduled_round_cannot_receive_contributions_before_round_advance() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context("member.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        start_circle_for_test(&mut contract, id, "creator.testnet", NOW + 2);
        let mut circle = contract.circles.get(&id).unwrap();
        circle.current_round = 1;
        circle.rounds[1].status = RoundStatus::Scheduled;
        contract.circles.insert(&id, &circle);
        set_context("member.testnet", 1, NOW + 3);
        contract.contribute(U64(id));
    }

    #[test]
    fn prestart_member_exit_releases_storage_to_platform_and_preserves_other_circle_indexes() {
        let mut contract = new_contract();
        let first_id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        set_context("alice.testnet", 0, NOW + 1);
        contract.join_public_circle(U64(first_id));
        set_context("bob.testnet", 0, NOW + 2);
        contract.join_public_circle(U64(first_id));
        let second_id = create_circle(&mut contract, "alice.testnet", CircleMode::Public, 2);
        let before = contract
            .get_storage_deposit(U64(first_id), account("owner.testnet"))
            .unwrap();
        assert_eq!(
            contract.get_storage_deposit(U64(first_id), account("alice.testnet")),
            None
        );
        set_context("alice.testnet", 0, NOW + 4);
        assert!(contract.request_member_exit(U64(first_id)));
        let summary = contract.get_circle(U64(first_id)).unwrap();
        assert_eq!(summary.member_count, 2);
        assert_eq!(summary.status, CircleStatus::RegistrationOpen);
        assert!(contract
            .get_circle_member(U64(first_id), account("alice.testnet"))
            .is_none());
        let remaining = contract.get_circle_members(U64(first_id), None, None);
        assert_eq!(remaining.len(), 2);
        assert!(remaining
            .iter()
            .any(|m| m.account_id == account("creator.testnet")));
        assert!(remaining
            .iter()
            .any(|m| m.account_id == account("bob.testnet")));
        set_context("alice.testnet", 0, NOW + 5);
        let alice_circles = contract.get_my_circles(None, None);
        assert_eq!(alice_circles.len(), 1);
        assert_eq!(alice_circles[0].circle_id.0, second_id);
        let after = contract
            .get_storage_deposit(U64(first_id), account("owner.testnet"))
            .unwrap();
        assert!(after.storage_bytes_released.0 > before.storage_bytes_released.0);
        assert!(after.available_refund_yocto.0 > before.available_refund_yocto.0);
        assert_eq!(
            contract.storage_refund_liability_yocto,
            contract
                .get_contract_config()
                .storage_refund_liability_yocto
                .0
        );
    }
    #[test]
    fn prestart_exit_shifts_long_account_ids_and_refunds_platform_sponsor() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        let exiting = account("a.testnet");
        let remaining = account("verylongmembername.testnet");
        set_context("a.testnet", 0, NOW + 1);
        contract.join_public_circle(U64(id));
        set_context("verylongmembername.testnet", 0, NOW + 2);
        contract.join_public_circle(U64(id));
        let before = contract
            .get_storage_deposit(U64(id), account("owner.testnet"))
            .unwrap();
        set_context("a.testnet", 0, NOW + 3);
        assert!(contract.request_member_exit(U64(id)));
        let members = contract.get_circle_members(U64(id), None, None);
        assert_eq!(members.len(), 2);
        assert_eq!(members[0].account_id, account("creator.testnet"));
        assert_eq!(members[1].account_id, remaining);
        let after = contract
            .get_storage_deposit(U64(id), account("owner.testnet"))
            .unwrap();
        assert!(after.storage_bytes_released.0 > before.storage_bytes_released.0);
        assert_eq!(contract.get_storage_deposit(U64(id), exiting), None);
        assert_eq!(
            contract.get_storage_deposit(U64(id), account("verylongmembername.testnet")),
            None
        );
    }
    #[test]
    #[should_panic(expected = "The creator cannot leave")]
    fn creator_cannot_leave_an_unstarted_circle() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context("creator.testnet", 0, NOW + 1);
        contract.request_member_exit(U64(id));
    }

    #[test]
    fn public_missed_contributions_are_recorded_and_votes_require_unanimous_other_members() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);

        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;
        set_context("creator.testnet", 1, NOW + 10);
        contract.contribute(U64(id));
        set_context("bob.testnet", 1, NOW + 11);
        contract.contribute(U64(id));
        let liability_before_votes = contract
            .get_contract_config()
            .contribution_liability_usdc_base_units
            .0;

        set_context("keeper.testnet", 5, NOW + 100);
        let scan = contract.record_missed_contributions(U64(id), None);
        assert!(scan.complete);
        assert_eq!(scan.processed_count, 3);
        assert_eq!(scan.missed_count, 1);
        assert_eq!(scan.next_cursor, 3);
        assert!(contract.has_ever_defaulted(U64(id), account("alice.testnet")));
        let missed = contract
            .get_missed_contribution(U64(id), 0, account("alice.testnet"))
            .unwrap();
        assert_eq!(missed.expected_amount_usdc_base_units.0, amount);
        assert!(missed.public_default_case);
        let case = contract
            .get_default_case(U64(id), 0, account("alice.testnet"))
            .unwrap();
        assert_eq!(case.status, DefaultCaseStatus::PendingVote);
        assert_eq!(case.eligible_voter_count, 2);

        set_context("bob.testnet", 1, NOW + 101);
        assert!(!contract.vote_remove_defaulted_member(U64(id), 0, account("alice.testnet"), true));
        let after_first = contract
            .get_default_case(U64(id), 0, account("alice.testnet"))
            .unwrap();
        assert_eq!(after_first.approve_count, 1);
        assert_eq!(after_first.status, DefaultCaseStatus::PendingVote);

        set_context("creator.testnet", 1, NOW + 102);
        assert!(contract.vote_remove_defaulted_member(U64(id), 0, account("alice.testnet"), true));
        let approved = contract
            .get_default_case(U64(id), 0, account("alice.testnet"))
            .unwrap();
        assert_eq!(approved.status, DefaultCaseStatus::RemovalApproved);
        assert_eq!(approved.approve_count, 2);
        let exit = contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .unwrap();
        assert_eq!(exit.reason, ExitReason::PublicDefaultRemoval);
        assert_eq!(exit.status, ExitSettlementStatus::Settled);
        assert_eq!(exit.gross_claim_usdc_base_units.0, 0);
        assert_eq!(exit.penalty_usdc_base_units.0, 0);
        assert!(contract
            .circles
            .get(&id)
            .unwrap()
            .payout_in_flight
            .is_none());
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            liability_before_votes,
            "A zero-principal removal creates no transfer and changes no liability"
        );
        assert!(contract
            .get_circle_member(U64(id), account("alice.testnet"))
            .is_none());
        let roster = contract.get_circle_members(U64(id), None, None);
        assert_eq!(roster.len(), 2);
        assert!(roster
            .iter()
            .all(|member| member.account_id != account("alice.testnet")));
    }

    #[test]
    fn one_rejection_closes_a_public_default_vote_without_removing_the_member() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);
        set_context("creator.testnet", 1, NOW + 10);
        contract.contribute(U64(id));
        set_context("bob.testnet", 1, NOW + 11);
        contract.contribute(U64(id));
        set_context("keeper.testnet", 5, NOW + 100);
        contract.record_missed_contributions(U64(id), None);

        set_context("bob.testnet", 1, NOW + 101);
        assert!(!contract.vote_remove_defaulted_member(
            U64(id),
            0,
            account("alice.testnet"),
            false
        ));
        let case = contract
            .get_default_case(U64(id), 0, account("alice.testnet"))
            .unwrap();
        assert_eq!(case.status, DefaultCaseStatus::RemovalRejected);
        assert_eq!(case.reject_count, 1);
        assert!(contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .is_none());
        assert!(contract
            .get_circle_member(U64(id), account("alice.testnet"))
            .is_some());
    }

    #[test]
    fn public_default_vote_window_closes_after_twenty_four_hours_without_removal() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);
        set_context("keeper.testnet", 5, NOW + 100);
        contract.record_missed_contributions(U64(id), None);

        let vote_deadline = NOW + 100 + PUBLIC_DEFAULT_VOTE_WINDOW_NS;
        set_context("anyone.testnet", 0, vote_deadline);
        assert!(contract.close_default_vote_window(U64(id), 0, account("alice.testnet")));
        let case = contract
            .get_default_case(U64(id), 0, account("alice.testnet"))
            .unwrap();
        assert_eq!(case.status, DefaultCaseStatus::VoteWindowExpired);
        assert!(contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .is_none());
        assert!(contract.has_ever_defaulted(U64(id), account("alice.testnet")));
    }

    #[test]
    fn private_circle_records_missed_payment_without_public_default_or_penalty_rules() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Private, 2);
        set_context("creator.testnet", 2, NOW + 1);
        contract.invite_private_member(U64(id), account("alice.testnet"));
        set_context("alice.testnet", 2, NOW + 2);
        contract.accept_private_invitation(U64(id));
        set_context("creator.testnet", 5, NOW + 3);
        contract.start_circle(U64(id), vec![U64(NOW + 100), U64(NOW + 200)]);

        set_context("keeper.testnet", 5, NOW + 100);
        let scan = contract.record_missed_contributions(U64(id), None);
        assert!(scan.complete);
        assert_eq!(scan.missed_count, 2);
        assert!(contract
            .get_missed_contribution(U64(id), 0, account("alice.testnet"))
            .is_some());
        assert!(contract
            .get_default_case(U64(id), 0, account("alice.testnet"))
            .is_none());
        assert!(!contract.has_ever_defaulted(U64(id), account("alice.testnet")));
    }

    #[test]
    fn missed_contribution_scan_is_bounded_to_twenty_five_members_per_call() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 26);
        for index in 0..25u32 {
            let member: AccountId = format!("m{:03}.testnet", index).parse().unwrap();
            set_context(member.as_ref(), 2, NOW + u64::from(index) + 1);
            contract.join_public_circle(U64(id));
        }
        let deadlines: Vec<U64> = (0..26u64)
            .map(|index| U64(NOW + 100 + index * 100))
            .collect();
        set_context("creator.testnet", 5, NOW + 50);
        contract.start_circle(U64(id), deadlines);

        set_context("keeper.testnet", 5, NOW + 100);
        let first = contract.record_missed_contributions(U64(id), None);
        assert_eq!(first.processed_count, 25);
        assert_eq!(first.missed_count, 25);
        assert_eq!(first.next_cursor, 25);
        assert!(!first.complete);

        set_context("keeper.testnet", 5, NOW + 101);
        let second = contract.record_missed_contributions(U64(id), None);
        assert_eq!(second.processed_count, 1);
        assert_eq!(second.missed_count, 26);
        assert_eq!(second.next_cursor, 26);
        assert!(second.complete);
    }

    #[test]
    fn default_removal_penalty_is_five_percent_of_verified_cumulative_member_contributions() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;
        let creator = account("creator.testnet");
        let alice = account("alice.testnet");
        let bob = account("bob.testnet");

        let mut circle = contract.circles.get(&id).unwrap();
        circle.rounds[0].status = RoundStatus::ContributionsComplete;
        circle.rounds[0].contribution_count = 3;
        circle.rounds[0].total_contributed_usdc_base_units = amount * 3;
        circle.current_round = 1;
        circle.rounds[1].status = RoundStatus::Open;
        contract.circles.insert(&id, &circle);
        for member in [creator.clone(), alice.clone(), bob.clone()] {
            contract.contributions.insert(
                &(id, 0, member.clone()),
                &ContributionRecord {
                    amount_usdc_base_units: amount,
                    receipt_id: [7u8; 32],
                    contributed_at_ns: NOW + 10,
                    block_height: 1,
                },
            );
            contract
                .member_contribution_totals
                .insert(&(id, member), &amount);
        }
        contract.contribution_liability_usdc_base_units += amount * 3;

        set_context("creator.testnet", 1, NOW + 50);
        contract.contribute(U64(id));
        set_context("bob.testnet", 1, NOW + 51);
        contract.contribute(U64(id));
        let liability_before_exit = contract
            .get_contract_config()
            .contribution_liability_usdc_base_units
            .0;

        set_context("keeper.testnet", 5, NOW + 200);
        contract.record_missed_contributions(U64(id), None);
        set_context("bob.testnet", 1, NOW + 201);
        assert!(!contract.vote_remove_defaulted_member(U64(id), 1, alice.clone(), true));
        set_context("creator.testnet", 1, NOW + 202);
        assert!(contract.vote_remove_defaulted_member(U64(id), 1, alice.clone(), true));

        let exit = contract.get_member_exit(U64(id), alice).unwrap();
        assert_eq!(exit.gross_claim_usdc_base_units.0, amount);
        assert_eq!(exit.penalty_basis_usdc_base_units.0, amount);
        assert_eq!(exit.penalty_bps, 500);
        assert_eq!(exit.penalty_usdc_base_units.0, amount / 20);
        assert_eq!(
            exit.net_claim_after_penalty_usdc_base_units.0,
            amount - amount / 20
        );
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            liability_before_exit,
            "Penalty remains a recorded claim adjustment until payout settlement"
        );
    }

    #[test]
    fn active_voluntary_exit_records_pending_claim_without_moving_contribution_funds() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context("member.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        start_circle_for_test(&mut contract, id, "creator.testnet", NOW + 2);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;

        set_context("creator.testnet", 1, NOW + 3);
        contract.contribute(U64(id));
        set_context("member.testnet", 1, NOW + 4);
        contract.contribute(U64(id));
        let liability_before_exit = contract
            .get_contract_config()
            .contribution_liability_usdc_base_units
            .0;

        set_context("member.testnet", 1, NOW + 5);
        assert!(!contract.request_member_exit(U64(id)));
        let exit = contract
            .get_member_exit(U64(id), account("member.testnet"))
            .unwrap();
        assert_eq!(exit.reason, ExitReason::Voluntary);
        assert_eq!(exit.status, ExitSettlementStatus::PendingSettlement);
        assert_eq!(exit.gross_claim_usdc_base_units.0, amount);
        assert_eq!(exit.penalty_usdc_base_units.0, 0);
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            liability_before_exit
        );
        assert!(contract
            .get_circle_member(U64(id), account("member.testnet"))
            .is_some());

        let mut circle = contract.circles.get(&id).unwrap();
        circle.current_round = 1;
        circle.rounds[1].status = RoundStatus::Open;
        contract.circles.insert(&id, &circle);
        set_context("member.testnet", 1, NOW + 6);
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.contribute(U64(id))
        }));
        assert!(
            blocked.is_err(),
            "An exit-pending member cannot contribute again"
        );
    }

    #[test]
    #[should_panic(expected = "Removal votes are public-circle only")]
    fn private_circle_cannot_use_public_default_removal_vote() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Private, 2);
        set_context("creator.testnet", 2, NOW + 1);
        contract.invite_private_member(U64(id), account("alice.testnet"));
        set_context("alice.testnet", 2, NOW + 2);
        contract.accept_private_invitation(U64(id));
        set_context("creator.testnet", 5, NOW + 3);
        contract.start_circle(U64(id), vec![U64(NOW + 100), U64(NOW + 200)]);
        set_context("creator.testnet", 1, NOW + 101);
        contract.vote_remove_defaulted_member(U64(id), 0, account("alice.testnet"), true);
    }

    #[test]
    fn under_minimum_circle_expires_and_pending_invites_are_expired() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Private, 4);

        set_context("creator.testnet", 1, NOW + 1);
        contract.invite_private_member(U64(id), account("invitee.testnet"));
        set_context("anyone.testnet", 0, DEADLINE + 1);
        contract.expire_unstarted_circle(U64(id));

        assert_eq!(
            contract.get_circle(U64(id)).unwrap().status,
            CircleStatus::Cancelled
        );
        assert_eq!(
            contract
                .get_circle(U64(id))
                .unwrap()
                .pending_invitation_count,
            0
        );
        assert_eq!(
            contract.get_invitation_status(U64(id), account("invitee.testnet")),
            Some(InvitationStatus::Expired)
        );
    }

    #[test]
    fn large_invitation_expiry_is_processed_in_bounded_batches() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Private, 100);

        for index in 0..26u32 {
            let invitee: AccountId = format!("inv{:03}.testnet", index).parse().unwrap();
            set_context("creator.testnet", 1, NOW + u64::from(index) + 1);
            contract.invite_private_member(U64(id), invitee);
        }

        set_context("anyone.testnet", 0, DEADLINE + 1);
        contract.expire_unstarted_circle(U64(id));
        let after_first_batch = contract.get_circle(U64(id)).unwrap();
        assert_eq!(after_first_batch.status, CircleStatus::Expiring);
        assert_eq!(after_first_batch.invitation_expiry_cursor, 25);
        assert_eq!(after_first_batch.pending_invitation_count, 26);
        assert_eq!(
            contract.get_invitation_status(U64(id), account("inv000.testnet")),
            Some(InvitationStatus::Expired)
        );
        assert_eq!(
            contract.get_invitation_status(U64(id), account("inv025.testnet")),
            Some(InvitationStatus::Pending)
        );

        set_context("anyone.testnet", 0, DEADLINE + 2);
        contract.expire_unstarted_circle(U64(id));
        let after_second_batch = contract.get_circle(U64(id)).unwrap();
        assert_eq!(after_second_batch.status, CircleStatus::Cancelled);
        assert_eq!(after_second_batch.invitation_expiry_cursor, 26);
        assert_eq!(after_second_batch.pending_invitation_count, 0);
        assert_eq!(
            contract.get_invitation_status(U64(id), account("inv025.testnet")),
            Some(InvitationStatus::Expired)
        );
    }
    #[test]
    #[should_panic(expected = "Circle registration is closed")]
    fn cancelled_circle_rejects_late_public_join() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);

        set_context("creator.testnet", 0, NOW + 1);
        contract.cancel_unstarted_circle(U64(id));

        set_context("member.testnet", 2, NOW + 2);
        contract.join_public_circle(U64(id));
    }

    #[test]
    fn full_public_circle_closes_registration_and_creator_can_start() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);

        set_context("member.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().status,
            CircleStatus::RegistrationClosed
        );

        start_circle_for_test(&mut contract, id, "creator.testnet", NOW + 2);
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().status,
            CircleStatus::Active
        );
    }

    #[test]
    #[should_panic(expected = "No pending invitation exists for this wallet")]
    fn private_invitation_cannot_be_claimed_by_another_wallet() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Private, 3);
        set_context("creator.testnet", 2, NOW + 1);
        contract.invite_private_member(U64(id), account("invitee.testnet"));
        set_context("attacker.testnet", 2, NOW + 2);
        contract.accept_private_invitation(U64(id));
    }

    #[test]
    #[should_panic(expected = "Only the creator may issue invitations")]
    fn non_creator_cannot_invite_into_a_private_circle() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Private, 3);
        set_context("member.testnet", 2, NOW + 1);
        contract.invite_private_member(U64(id), account("invitee.testnet"));
    }

    #[test]
    #[should_panic(expected = "Circle has not reached its minimum member count")]
    fn creator_cannot_start_below_minimum_members() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);
        set_context("anyone.testnet", 0, DEADLINE + 1);
        contract.close_registration(U64(id));
        start_circle_for_test(&mut contract, id, "creator.testnet", DEADLINE + 2);
    }

    fn setup_private_two_member_circle(
        contract: &mut CentralCircleContract,
        start_timestamp: u64,
    ) -> u64 {
        let id = create_circle(contract, "creator.testnet", CircleMode::Private, 2);
        set_context("creator.testnet", 2, start_timestamp + 1);
        contract.invite_private_member(U64(id), account("alice.testnet"));
        set_context("alice.testnet", 2, start_timestamp + 2);
        contract.accept_private_invitation(U64(id));
        set_context("creator.testnet", 5, start_timestamp + 3);
        contract.start_circle(
            U64(id),
            vec![U64(start_timestamp + 100), U64(start_timestamp + 200)],
        );
        id
    }

    #[test]
    fn payout_engine_preflights_nep145_registration_then_calls_circle_usdc_ft_transfer() {
        let mut contract = new_contract();
        let id = setup_private_two_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;
        for member in ["creator.testnet", "alice.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }

        set_context("creator.testnet", 0, NOW + 20);
        let _preflight_promise = contract.start_private_round_payout(U64(id));
        let attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        let token_id = contract.usdc_token_id.clone();
        // The direct unit-test call does not run the generated ABI wrapper; drop
        // the returned promise to finalize its receipt graph in the mock runtime.
        drop(_preflight_promise);

        let receipts = get_created_receipts();
        let preflight_args = receipts
            .iter()
            .find(|receipt| receipt.receiver_id == token_id)
            .and_then(|receipt| {
                receipt.actions.iter().find_map(|action| match action {
                    MockAction::FunctionCallWeight {
                        method_name,
                        args,
                        attached_deposit,
                        ..
                    } if method_name.as_slice() == b"storage_balance_of" => {
                        assert_eq!(*attached_deposit, NearToken::from_yoctonear(0));
                        Some(args.clone())
                    }
                    _ => None,
                })
            })
            .expect("Payout must preflight NEP-145 recipient registration");
        let preflight: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_slice(&preflight_args).unwrap();
        assert_eq!(preflight["account_id"], "creator.testnet");
        assert!(receipts
            .iter()
            .flat_map(|receipt| receipt.actions.iter())
            .all(|action| !matches!(action, MockAction::Transfer { .. })));

        let fingerprint =
            CentralCircleContract::payout_attempt_fingerprint(id, &token_id, &attempt);
        testing_env_with_promise_results(
            callback_context(),
            PromiseResult::Successful(
                br#"{"total":"10000000000000","available":"10000000000000"}"#.to_vec(),
            ),
        );
        let transfer_result =
            contract.on_circle_payout_storage_checked(U64(id), U64(attempt.nonce), fingerprint);
        assert!(matches!(&transfer_result, PromiseOrValue::Promise(_)));
        drop(transfer_result);

        let transfer_receipts = get_created_receipts();
        let transfer_args = transfer_receipts
            .iter()
            .find(|receipt| receipt.receiver_id == token_id)
            .and_then(|receipt| {
                receipt.actions.iter().find_map(|action| match action {
                    MockAction::FunctionCallWeight {
                        method_name,
                        args,
                        attached_deposit,
                        prepaid_gas,
                        ..
                    } if method_name.as_slice() == b"ft_transfer" => {
                        assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
                        assert_eq!(*prepaid_gas, Gas::from_tgas(USDC_FT_TRANSFER_GAS_TGAS));
                        Some(args.clone())
                    }
                    _ => None,
                })
            })
            .expect("USDC token contract must receive ft_transfer, not native NEAR transfer");
        let transfer: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_slice(&transfer_args).unwrap();
        assert_eq!(transfer["receiver_id"], "creator.testnet");
        assert_eq!(
            transfer["amount"],
            attempt.transfer_amount_usdc_base_units.to_string()
        );
        assert_eq!(
            transfer["memo"],
            format!(
                "ajocircle:{}:{}:{}",
                id,
                attempt.nonce,
                CentralCircleContract::payout_attempt_fingerprint(id, &token_id, &attempt)
            )
        );
        assert!(transfer_receipts
            .iter()
            .flat_map(|receipt| receipt.actions.iter())
            .all(|action| !matches!(action, MockAction::Transfer { .. })));
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            amount * 2,
            "Preflight and FT dispatch do not release principal liability"
        );

        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &attempt));
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            0,
            "Principal is released only after the successful FT callback"
        );
    }

    #[test]
    fn private_round_payout_is_creator_authorized_and_releases_liability_only_on_success() {
        let mut contract = new_contract();
        let id = setup_private_two_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;
        for member in ["creator.testnet", "alice.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }
        let gross = amount * 2;
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            gross
        );
        set_context("attacker.testnet", 0, NOW + 20);
        let unauthorized = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.start_private_round_payout(U64(id))
        }));
        assert!(
            unauthorized.is_err(),
            "A non-creator cannot authorize a private payout"
        );
        set_context("creator.testnet", 0, NOW + 21);
        let _promise = contract.start_private_round_payout(U64(id));
        let circle = contract.circles.get(&id).unwrap();
        let attempt = circle.payout_in_flight.clone().unwrap();
        assert_eq!(attempt.recipient, account("creator.testnet"));
        assert_eq!(attempt.gross_amount_usdc_base_units, gross);
        let expected_fee = CentralCircleContract::basis_point_amount(gross, DISTRIBUTION_FEE_BPS);
        assert_eq!(attempt.distribution_fee_usdc_base_units, expected_fee);
        assert_eq!(
            attempt.transfer_amount_usdc_base_units,
            gross - expected_fee
        );
        assert_eq!(circle.rounds[0].status, RoundStatus::PayoutInFlight);
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            gross,
            "Pending transfers remain fully protected"
        );
        let duplicate = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.start_private_round_payout(U64(id))
        }));
        assert!(
            duplicate.is_err(),
            "A second transfer cannot be launched while one is in flight"
        );
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &attempt));
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            0
        );
        assert_eq!(
            contract
                .get_contract_config()
                .distribution_fee_liability_usdc_base_units
                .0,
            expected_fee
        );
        let settled = contract.circles.get(&id).unwrap();
        assert_eq!(settled.rounds[0].status, RoundStatus::PaidOut);
        assert_eq!(settled.current_round, 1);
        assert_eq!(settled.rounds[1].status, RoundStatus::Open);
        assert!(settled.payout_in_flight.is_none());
    }

    #[test]
    fn private_round_waits_for_full_pot_and_accepts_verified_late_cure() {
        let mut contract = new_contract();
        let id = setup_private_two_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;

        // The creator pays before the deadline; the invitee misses it.
        set_context("creator.testnet", 1, NOW + 10);
        contract.contribute(U64(id));
        set_context("keeper.testnet", 5, NOW + 101);
        let scan = contract.record_missed_contributions(U64(id), None);
        assert!(scan.complete);
        assert_eq!(scan.missed_count, 1);

        set_context("creator.testnet", 0, NOW + 102);
        let partial_payout = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.start_private_round_payout(U64(id))
        }));
        assert!(
            partial_payout.is_err(),
            "A private round must not pay its recipient from an incomplete pot"
        );
        let waiting = contract.get_circle(U64(id)).unwrap();
        assert_eq!(waiting.status, CircleStatus::Active);
        assert_eq!(waiting.current_round, 0);
        assert_eq!(
            contract.get_current_round(U64(id)).unwrap().status,
            RoundStatus::DeadlinePassed
        );
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            amount,
            "The partial contribution remains fully protected while the round waits"
        );

        // The invited member can cure only their own verified miss by paying the exact
        // contribution. The original deadline is not changed.
        set_context("alice.testnet", 1, NOW + 110);
        contract.contribute(U64(id));
        let cured_round = contract.get_current_round(U64(id)).unwrap();
        assert_eq!(cured_round.status, RoundStatus::ContributionsComplete);
        assert_eq!(cured_round.contribution_count, 2);
        assert_eq!(cured_round.total_contributed_usdc_base_units.0, amount * 2);
        let late_receipt = contract
            .get_round_contribution(U64(id), 0, account("alice.testnet"))
            .unwrap();
        assert!(late_receipt.contributed_at_ns.0 > cured_round.deadline_ns.0);

        set_context("creator.testnet", 0, NOW + 111);
        let _promise = contract.start_private_round_payout(U64(id));
        let attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(attempt.recipient, account("creator.testnet"));
        assert_eq!(attempt.gross_amount_usdc_base_units, amount * 2);
        assert_eq!(
            attempt.transfer_amount_usdc_base_units,
            amount * 2 - attempt.distribution_fee_usdc_base_units
        );
    }

    #[test]
    fn public_default_penalty_accumulates_five_percent_per_missed_round_when_member_stays() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;

        for member in ["creator.testnet", "alice.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 0, NOW + 20);
        assert!(!contract.advance_public_round(U64(id)));

        for member in ["creator.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 25);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 5, NOW + 201);
        assert!(contract.record_missed_contributions(U64(id), None).complete);
        set_context("creator.testnet", 1, NOW + 202);
        assert!(!contract.vote_remove_defaulted_member(
            U64(id),
            1,
            account("alice.testnet"),
            false
        ));
        set_context("keeper.testnet", 0, NOW + 203);
        assert!(!contract.advance_public_round(U64(id)));

        for member in ["creator.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 205);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 5, NOW + 301);
        assert!(contract.record_missed_contributions(U64(id), None).complete);
        set_context("creator.testnet", 1, NOW + 302);
        assert!(!contract.vote_remove_defaulted_member(
            U64(id),
            2,
            account("alice.testnet"),
            false
        ));
        set_context("keeper.testnet", 0, NOW + 303);
        assert!(contract.advance_public_round(U64(id)));

        let circle = contract.circles.get(&id).unwrap();
        assert_eq!(
            contract.member_public_default_count(&circle, &account("alice.testnet")),
            2
        );
        assert!(contract
            .get_circle_member(U64(id), account("alice.testnet"))
            .is_some());
        assert!(contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .is_none());

        set_context("keeper.testnet", 0, NOW + 304);
        let _creator_payout = contract.continue_public_distribution(U64(id));
        let creator_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(creator_attempt.recipient, account("creator.testnet"));
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(
            &mut contract,
            id,
            &creator_attempt
        ));

        set_context("keeper.testnet", 0, NOW + 305);
        let _alice_payout = contract.continue_public_distribution(U64(id));
        let alice_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        let expected_penalty =
            CentralCircleContract::basis_point_amount(amount, PUBLIC_DEFAULT_PENALTY_BPS * 2);
        let expected_fee = CentralCircleContract::basis_point_amount(amount, DISTRIBUTION_FEE_BPS);
        assert_eq!(alice_attempt.recipient, account("alice.testnet"));
        assert_eq!(alice_attempt.gross_amount_usdc_base_units, amount);
        assert_eq!(
            alice_attempt.penalty_amount_usdc_base_units,
            expected_penalty
        );
        assert_eq!(alice_attempt.distribution_fee_usdc_base_units, expected_fee);
        assert_eq!(
            alice_attempt.transfer_amount_usdc_base_units,
            amount - expected_penalty - expected_fee
        );
        assert!(contract
            .get_circle_member(U64(id), account("alice.testnet"))
            .is_some());
        assert!(contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .is_none());
    }

    #[test]
    fn public_default_removal_after_second_default_records_ten_percent_until_distribution() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;

        for member in ["creator.testnet", "alice.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 0, NOW + 20);
        assert!(!contract.advance_public_round(U64(id)));

        for member in ["creator.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 25);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 5, NOW + 201);
        assert!(contract.record_missed_contributions(U64(id), None).complete);
        set_context("creator.testnet", 1, NOW + 202);
        assert!(!contract.vote_remove_defaulted_member(
            U64(id),
            1,
            account("alice.testnet"),
            false
        ));
        set_context("keeper.testnet", 0, NOW + 203);
        assert!(!contract.advance_public_round(U64(id)));

        for member in ["creator.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 205);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 5, NOW + 301);
        assert!(contract.record_missed_contributions(U64(id), None).complete);
        set_context("creator.testnet", 1, NOW + 302);
        assert!(!contract.vote_remove_defaulted_member(U64(id), 2, account("alice.testnet"), true));
        set_context("bob.testnet", 1, NOW + 303);
        assert!(contract.vote_remove_defaulted_member(U64(id), 2, account("alice.testnet"), true));
        let pending_exit = contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .unwrap();
        let default_exit_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        let exit_preflight_receipts = get_created_receipts();
        assert!(
            exit_preflight_receipts.iter().any(|receipt| {
                receipt.receiver_id == contract.usdc_token_id
                    && receipt.actions.iter().any(|action| {
                        matches!(
                            action,
                            MockAction::FunctionCallWeight { method_name, .. }
                                if method_name.as_slice() == b"storage_balance_of"
                        )
                    })
            }),
            "Unanimous default approval must start the USDC recipient-registration preflight"
        );
        assert!(
            exit_preflight_receipts
                .iter()
                .flat_map(|receipt| receipt.actions.iter())
                .all(|action| !matches!(
                    action,
                    MockAction::FunctionCallWeight { method_name, .. }
                        if method_name.as_slice() == b"ft_transfer"
                )),
            "USDC must not transfer before the NEP-145 preflight callback"
        );
        let exit_penalty =
            CentralCircleContract::basis_point_amount(amount, PUBLIC_DEFAULT_PENALTY_BPS * 2);
        let exit_fee = CentralCircleContract::basis_point_amount(amount, DISTRIBUTION_FEE_BPS);
        assert_eq!(pending_exit.status, ExitSettlementStatus::PendingSettlement);
        assert_eq!(pending_exit.penalty_bps, 1_000);
        assert_eq!(pending_exit.penalty_usdc_base_units.0, exit_penalty);
        assert_eq!(default_exit_attempt.kind, PayoutKind::PublicDefaultExit);
        assert_eq!(default_exit_attempt.recipient, account("alice.testnet"));
        assert_eq!(default_exit_attempt.round_index, 2);
        assert_eq!(default_exit_attempt.gross_amount_usdc_base_units, amount);
        assert_eq!(
            default_exit_attempt.penalty_amount_usdc_base_units,
            exit_penalty
        );
        assert_eq!(
            default_exit_attempt.distribution_fee_usdc_base_units,
            exit_fee
        );
        assert_eq!(
            default_exit_attempt.transfer_amount_usdc_base_units,
            amount - exit_penalty - exit_fee
        );
        assert_eq!(
            pending_exit.net_claim_after_penalty_usdc_base_units.0,
            amount - exit_penalty
        );

        // A definite USDC transfer failure retains the same claim and principal liability.
        let storage_before_failed_exit_callback = env::storage_usage();
        testing_env_with_promise_results(callback_context(), PromiseResult::Failed);
        assert!(!complete_payout_for_test(
            &mut contract,
            id,
            &default_exit_attempt
        ));
        set_context_after_callback(
            "keeper.testnet",
            NOW + 303,
            storage_before_failed_exit_callback,
        );
        let failed_state = contract.get_circle_payout_state(U64(id)).unwrap();
        assert!(failed_state.in_flight.is_none());
        let failed_exit_attempt = failed_state.failed.unwrap();
        assert_eq!(failed_exit_attempt.recipient, account("alice.testnet"));
        assert_eq!(failed_exit_attempt.gross_amount_usdc_base_units.0, amount);
        assert_eq!(
            failed_exit_attempt.transfer_amount_usdc_base_units.0,
            default_exit_attempt.transfer_amount_usdc_base_units
        );
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            amount * 7
        );
        let advance_while_failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.advance_public_round(U64(id))
        }));
        assert!(advance_while_failed.is_err());

        // Retry reuses the exact economic instruction with a fresh nonce.
        set_context("keeper.testnet", 0, NOW + 304);
        let _retry = contract.retry_circle_payout(U64(id));
        let retry_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(retry_attempt.kind, PayoutKind::PublicDefaultExit);
        assert_eq!(retry_attempt.nonce, default_exit_attempt.nonce + 1);
        assert_eq!(retry_attempt.retry_count, 1);
        assert_eq!(retry_attempt.recipient, default_exit_attempt.recipient);
        assert_eq!(
            retry_attempt.gross_amount_usdc_base_units,
            default_exit_attempt.gross_amount_usdc_base_units
        );
        assert_eq!(
            retry_attempt.penalty_amount_usdc_base_units,
            default_exit_attempt.penalty_amount_usdc_base_units
        );
        assert_eq!(
            retry_attempt.distribution_fee_usdc_base_units,
            default_exit_attempt.distribution_fee_usdc_base_units
        );
        assert_eq!(
            retry_attempt.transfer_amount_usdc_base_units,
            default_exit_attempt.transfer_amount_usdc_base_units
        );

        let storage_before_retry_callback = env::storage_usage();
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &retry_attempt));
        set_context_after_callback("keeper.testnet", NOW + 304, storage_before_retry_callback);
        let config_after_exit = contract.get_contract_config();
        assert_eq!(
            config_after_exit.contribution_liability_usdc_base_units.0,
            amount * 6
        );
        assert_eq!(
            config_after_exit.penalty_liability_usdc_base_units.0,
            exit_penalty
        );
        assert_eq!(
            config_after_exit
                .distribution_fee_liability_usdc_base_units
                .0,
            exit_fee
        );
        let removed_exit = contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .unwrap();
        assert_eq!(removed_exit.status, ExitSettlementStatus::Settled);
        assert_eq!(removed_exit.penalty_bps, 1_000);
        assert_eq!(removed_exit.penalty_usdc_base_units.0, exit_penalty);
        assert!(contract
            .get_circle_member(U64(id), account("alice.testnet"))
            .is_none());
        assert!(contract
            .get_circle_members(U64(id), None, None)
            .iter()
            .all(|member| member.account_id != account("alice.testnet")));

        set_context("keeper.testnet", 0, NOW + 305);
        assert!(contract.advance_public_round(U64(id)));
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().status,
            CircleStatus::SettlementReady
        );

        set_context("keeper.testnet", 0, NOW + 306);
        let _creator_payout = contract.continue_public_distribution(U64(id));
        let circle_after_start = contract.get_circle(U64(id)).unwrap();
        assert_eq!(
            circle_after_start
                .public_distribution_remaining_usdc_base_units
                .0,
            amount * 6,
            "Final distribution excludes principal already paid by the exit transfer"
        );
        let creator_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(creator_attempt.recipient, account("creator.testnet"));
        assert_eq!(creator_attempt.gross_amount_usdc_base_units, amount * 3);
        assert_ne!(creator_attempt.recipient, account("alice.testnet"));
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            amount * 6
        );
    }

    #[test]
    fn public_default_exit_unregistered_recipient_preserves_claim_and_blocks_progression() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;

        for member in ["creator.testnet", "alice.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 0, NOW + 20);
        assert!(!contract.advance_public_round(U64(id)));

        for member in ["creator.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 25);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 5, NOW + 201);
        assert!(contract.record_missed_contributions(U64(id), None).complete);
        set_context("creator.testnet", 1, NOW + 202);
        assert!(!contract.vote_remove_defaulted_member(
            U64(id),
            1,
            account("alice.testnet"),
            false
        ));
        set_context("keeper.testnet", 0, NOW + 203);
        assert!(!contract.advance_public_round(U64(id)));

        for member in ["creator.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 205);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 5, NOW + 301);
        assert!(contract.record_missed_contributions(U64(id), None).complete);
        set_context("creator.testnet", 1, NOW + 302);
        assert!(!contract.vote_remove_defaulted_member(U64(id), 2, account("alice.testnet"), true));
        set_context("bob.testnet", 1, NOW + 303);
        assert!(contract.vote_remove_defaulted_member(U64(id), 2, account("alice.testnet"), true));

        let attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(attempt.kind, PayoutKind::PublicDefaultExit);
        assert_eq!(attempt.recipient, account("alice.testnet"));
        assert_eq!(attempt.penalty_amount_usdc_base_units, amount / 10);
        let liability_before = contract
            .get_contract_config()
            .contribution_liability_usdc_base_units
            .0;
        let fingerprint = CentralCircleContract::payout_attempt_fingerprint(
            id,
            &contract.usdc_token_id,
            &attempt,
        );

        // An unregistered exit recipient must stop at NEP-145; no USDC transfer is submitted.
        testing_env_with_promise_results(
            callback_context(),
            PromiseResult::Successful(b"null".to_vec()),
        );
        let preflight =
            contract.on_circle_payout_storage_checked(U64(id), U64(attempt.nonce), fingerprint);
        assert!(matches!(preflight, PromiseOrValue::Value(false)));

        let state = contract.get_circle_payout_state(U64(id)).unwrap();
        assert!(state.in_flight.is_none());
        let failed = state.failed.unwrap();
        assert_eq!(failed.kind, PayoutKind::PublicDefaultExit);
        assert_eq!(failed.nonce.0, attempt.nonce);
        assert_eq!(failed.recipient, attempt.recipient);
        assert_eq!(
            failed.transfer_amount_usdc_base_units.0,
            attempt.transfer_amount_usdc_base_units
        );
        assert_eq!(
            contract
                .get_member_exit(U64(id), account("alice.testnet"))
                .unwrap()
                .status,
            ExitSettlementStatus::PendingSettlement
        );
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            liability_before
        );
        assert!(get_created_receipts()
            .iter()
            .flat_map(|receipt| receipt.actions.iter())
            .all(|action| !matches!(
                action,
                MockAction::FunctionCallWeight { method_name, .. }
                    if method_name.as_slice() == b"ft_transfer"
            )));

        set_context("keeper.testnet", 0, NOW + 304);
        let advance = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.advance_public_round(U64(id))
        }));
        assert!(
            advance.is_err(),
            "An unsettled default exit must block progression"
        );

        let _retry = contract.retry_circle_payout(U64(id));
        let retry = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(retry.kind, PayoutKind::PublicDefaultExit);
        assert_eq!(retry.nonce, attempt.nonce + 1);
        assert_eq!(retry.retry_count, 1);
        assert_eq!(retry.recipient, attempt.recipient);
        assert_eq!(
            retry.gross_amount_usdc_base_units,
            attempt.gross_amount_usdc_base_units
        );
        assert_eq!(
            retry.penalty_amount_usdc_base_units,
            attempt.penalty_amount_usdc_base_units
        );
        assert_eq!(
            retry.distribution_fee_usdc_base_units,
            attempt.distribution_fee_usdc_base_units
        );
        assert_eq!(
            retry.transfer_amount_usdc_base_units,
            attempt.transfer_amount_usdc_base_units
        );
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            liability_before
        );
    }

    #[test]
    fn public_default_exit_storage_preflight_failure_preserves_claim_and_blocks_progression() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);

        for member in ["creator.testnet", "alice.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 0, NOW + 20);
        assert!(!contract.advance_public_round(U64(id)));

        for member in ["creator.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 25);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 5, NOW + 201);
        assert!(contract.record_missed_contributions(U64(id), None).complete);
        set_context("creator.testnet", 1, NOW + 202);
        assert!(!contract.vote_remove_defaulted_member(
            U64(id),
            1,
            account("alice.testnet"),
            false
        ));
        set_context("keeper.testnet", 0, NOW + 203);
        assert!(!contract.advance_public_round(U64(id)));

        for member in ["creator.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 205);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 5, NOW + 301);
        assert!(contract.record_missed_contributions(U64(id), None).complete);
        set_context("creator.testnet", 1, NOW + 302);
        assert!(!contract.vote_remove_defaulted_member(U64(id), 2, account("alice.testnet"), true));
        set_context("bob.testnet", 1, NOW + 303);
        assert!(contract.vote_remove_defaulted_member(U64(id), 2, account("alice.testnet"), true));

        let attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(attempt.kind, PayoutKind::PublicDefaultExit);
        assert_eq!(attempt.recipient, account("alice.testnet"));
        let liability_before = contract
            .get_contract_config()
            .contribution_liability_usdc_base_units
            .0;
        let fingerprint = CentralCircleContract::payout_attempt_fingerprint(
            id,
            &contract.usdc_token_id,
            &attempt,
        );

        let preflight_receipts = get_created_receipts();
        assert!(preflight_receipts
            .iter()
            .flat_map(|receipt| receipt.actions.iter())
            .any(|action| matches!(
                action,
                MockAction::FunctionCallWeight { method_name, .. }
                    if method_name.as_slice() == b"storage_balance_of"
            )));

        // A failed NEP-145 query is unresolved, so the exit claim remains pending.
        testing_env_with_promise_results(callback_context(), PromiseResult::Failed);
        let preflight =
            contract.on_circle_payout_storage_checked(U64(id), U64(attempt.nonce), fingerprint);
        assert!(matches!(preflight, PromiseOrValue::Value(false)));

        let state = contract.get_circle_payout_state(U64(id)).unwrap();
        assert!(state.in_flight.is_none());
        let failed = state.failed.unwrap();
        assert_eq!(failed.kind, PayoutKind::PublicDefaultExit);
        assert_eq!(failed.nonce.0, attempt.nonce);
        assert_eq!(failed.retry_count, 0);
        assert_eq!(failed.recipient, attempt.recipient);
        assert_eq!(
            failed.transfer_amount_usdc_base_units.0,
            attempt.transfer_amount_usdc_base_units
        );
        assert_eq!(
            contract
                .get_member_exit(U64(id), account("alice.testnet"))
                .unwrap()
                .status,
            ExitSettlementStatus::PendingSettlement
        );
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            liability_before
        );
        assert!(get_created_receipts()
            .iter()
            .flat_map(|receipt| receipt.actions.iter())
            .all(|action| !matches!(
                action,
                MockAction::FunctionCallWeight { method_name, .. }
                    if method_name.as_slice() == b"ft_transfer"
            )));

        set_context("keeper.testnet", 0, NOW + 304);
        let advance = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.advance_public_round(U64(id))
        }));
        assert!(
            advance.is_err(),
            "An exit with an unresolved storage preflight must block progression"
        );

        let _retry = contract.retry_circle_payout(U64(id));
        let retry = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(retry.kind, PayoutKind::PublicDefaultExit);
        assert_eq!(retry.nonce, attempt.nonce + 1);
        assert_eq!(retry.retry_count, 1);
        assert_eq!(retry.recipient, attempt.recipient);
        assert_eq!(
            retry.gross_amount_usdc_base_units,
            attempt.gross_amount_usdc_base_units
        );
        assert_eq!(
            retry.penalty_amount_usdc_base_units,
            attempt.penalty_amount_usdc_base_units
        );
        assert_eq!(
            retry.distribution_fee_usdc_base_units,
            attempt.distribution_fee_usdc_base_units
        );
        assert_eq!(
            retry.transfer_amount_usdc_base_units,
            attempt.transfer_amount_usdc_base_units
        );
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            liability_before
        );
    }

    #[test]
    fn public_default_penalty_applies_even_when_voters_keep_the_member_in_the_circle() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context("alice.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        set_context("creator.testnet", 5, NOW + 3);
        contract.start_circle(U64(id), vec![U64(NOW + 100), U64(NOW + 200)]);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;

        for member in ["creator.testnet", "alice.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 0, NOW + 20);
        assert!(!contract.advance_public_round(U64(id)));

        set_context("creator.testnet", 1, NOW + 25);
        contract.contribute(U64(id));
        set_context("keeper.testnet", 5, NOW + 201);
        let scan = contract.record_missed_contributions(U64(id), None);
        assert!(scan.complete);
        assert_eq!(scan.missed_count, 1);

        // The sole eligible voter explicitly rejects removal. The default record
        // remains and the member stays active, but the 5% payout deduction remains.
        set_context("creator.testnet", 1, NOW + 202);
        assert!(!contract.vote_remove_defaulted_member(
            U64(id),
            1,
            account("alice.testnet"),
            false
        ));
        assert!(contract
            .get_circle_member(U64(id), account("alice.testnet"))
            .is_some());
        assert!(contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .is_none());

        set_context("keeper.testnet", 0, NOW + 203);
        assert!(contract.advance_public_round(U64(id)));
        set_context("keeper.testnet", 0, NOW + 204);
        let _creator_payout = contract.continue_public_distribution(U64(id));
        let creator_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(creator_attempt.recipient, account("creator.testnet"));
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(
            &mut contract,
            id,
            &creator_attempt
        ));

        set_context("keeper.testnet", 0, NOW + 205);
        let _alice_payout = contract.continue_public_distribution(U64(id));
        let alice_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        let expected_penalty =
            CentralCircleContract::basis_point_amount(amount, PUBLIC_DEFAULT_PENALTY_BPS);
        let expected_fee = CentralCircleContract::basis_point_amount(amount, DISTRIBUTION_FEE_BPS);
        assert_eq!(alice_attempt.recipient, account("alice.testnet"));
        assert_eq!(alice_attempt.gross_amount_usdc_base_units, amount);
        assert_eq!(
            alice_attempt.penalty_amount_usdc_base_units,
            expected_penalty
        );
        assert_eq!(alice_attempt.distribution_fee_usdc_base_units, expected_fee);
        assert_eq!(
            alice_attempt.transfer_amount_usdc_base_units,
            amount - expected_penalty - expected_fee
        );
        assert!(contract
            .get_circle_member(U64(id), account("alice.testnet"))
            .is_some());
        assert!(contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .is_none());
    }

    #[test]
    fn failed_private_payout_is_retryable_with_a_new_nonce_and_callback_replay_is_rejected() {
        let mut contract = new_contract();
        let id = setup_private_two_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;
        for member in ["creator.testnet", "alice.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }
        let gross = amount * 2;
        set_context("creator.testnet", 0, NOW + 20);
        let _promise = contract.start_private_round_payout(U64(id));
        let first = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        testing_env_with_promise_results(callback_context(), PromiseResult::Failed);
        assert!(!complete_payout_for_test(&mut contract, id, &first));
        let payout_state = contract.get_circle_payout_state(U64(id)).unwrap();
        assert_eq!(payout_state.next_nonce.0, first.nonce + 1);
        assert!(payout_state.in_flight.is_none());
        let failed_attempt = payout_state.failed.unwrap();
        assert_eq!(failed_attempt.nonce.0, first.nonce);
        assert_eq!(failed_attempt.retry_count, 0);
        assert_eq!(failed_attempt.recipient, account("creator.testnet"));
        assert_eq!(failed_attempt.gross_amount_usdc_base_units.0, gross);
        assert_eq!(
            failed_attempt.transfer_amount_usdc_base_units.0,
            first.transfer_amount_usdc_base_units
        );
        let after_failure = contract.circles.get(&id).unwrap();
        assert!(after_failure.payout_in_flight.is_none());
        assert_eq!(
            after_failure.payout_failed.as_ref().unwrap().recipient,
            account("creator.testnet")
        );
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            gross
        );
        assert_eq!(
            contract
                .get_contract_config()
                .distribution_fee_liability_usdc_base_units
                .0,
            0
        );
        assert_eq!(
            after_failure.rounds[0].status,
            RoundStatus::ContributionsComplete
        );
        set_context("keeper.testnet", 0, NOW + 22);
        let _retry = contract.retry_circle_payout(U64(id));
        let second = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(second.nonce, first.nonce + 1);
        assert_eq!(second.retry_count, 1);
        assert_eq!(second.recipient, first.recipient);
        assert_eq!(
            second.transfer_amount_usdc_base_units,
            first.transfer_amount_usdc_base_units
        );
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &second));
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            0
        );
        assert_eq!(
            contract
                .get_contract_config()
                .distribution_fee_liability_usdc_base_units
                .0,
            first.distribution_fee_usdc_base_units
        );
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        let replay = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            complete_payout_for_test(&mut contract, id, &second)
        }));
        assert!(
            replay.is_err(),
            "A completed payout callback cannot be replayed"
        );
    }

    #[test]
    fn payout_retries_stop_after_three_without_releasing_member_principal() {
        let mut contract = new_contract();
        let id = setup_private_two_member_circle(&mut contract, NOW);
        for member in ["creator.testnet", "alice.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }
        let gross = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0
            * 2;
        set_context("creator.testnet", 0, NOW + 20);
        let _initial = contract.start_private_round_payout(U64(id));
        let first = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        let mut current = first.clone();

        for retry_number in 0..=MAX_PAYOUT_RETRIES {
            testing_env_with_promise_results(callback_context(), PromiseResult::Failed);
            assert!(!complete_payout_for_test(&mut contract, id, &current));
            let failed = contract.circles.get(&id).unwrap().payout_failed.unwrap();
            assert_eq!(failed.retry_count, retry_number);
            assert_eq!(failed.recipient, first.recipient);
            assert_eq!(
                failed.gross_amount_usdc_base_units,
                first.gross_amount_usdc_base_units
            );
            assert_eq!(
                failed.penalty_amount_usdc_base_units,
                first.penalty_amount_usdc_base_units
            );
            assert_eq!(
                failed.distribution_fee_usdc_base_units,
                first.distribution_fee_usdc_base_units
            );
            assert_eq!(
                failed.transfer_amount_usdc_base_units,
                first.transfer_amount_usdc_base_units
            );

            if retry_number < MAX_PAYOUT_RETRIES {
                set_context("keeper.testnet", 0, NOW + 30 + u64::from(retry_number));
                let _retry = contract.retry_circle_payout(U64(id));
                current = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
                assert_eq!(current.retry_count, retry_number + 1);
                assert_eq!(current.nonce, first.nonce + u64::from(retry_number) + 1);
            } else {
                let exhausted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    contract.retry_circle_payout(U64(id))
                }));
                assert!(exhausted.is_err(), "Retry cap must fail closed");
                let state = contract.get_circle_payout_state(U64(id)).unwrap();
                assert!(state.in_flight.is_none());
                assert_eq!(state.failed.unwrap().retry_count, MAX_PAYOUT_RETRIES);
                assert_eq!(
                    contract
                        .get_contract_config()
                        .contribution_liability_usdc_base_units
                        .0,
                    gross,
                    "Exhausted retries leave every USDC principal unit protected"
                );
            }
        }
    }

    #[test]
    fn malformed_nep145_storage_response_keeps_payout_locked_without_transfer() {
        let mut contract = new_contract();
        let id = setup_private_two_member_circle(&mut contract, NOW);
        for member in ["creator.testnet", "alice.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }

        set_context("creator.testnet", 0, NOW + 20);
        let _preflight = contract.start_private_round_payout(U64(id));
        let attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        let fingerprint = CentralCircleContract::payout_attempt_fingerprint(
            id,
            &contract.usdc_token_id,
            &attempt,
        );
        let liability_before = contract
            .get_contract_config()
            .contribution_liability_usdc_base_units
            .0;

        testing_env_with_promise_results(
            callback_context(),
            PromiseResult::Successful(b"{not-valid-json".to_vec()),
        );
        let malformed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.on_circle_payout_storage_checked(U64(id), U64(attempt.nonce), fingerprint)
        }));
        assert!(
            malformed.is_err(),
            "Malformed NEP-145 data must fail closed rather than dispatch a transfer"
        );

        let state = contract.get_circle_payout_state(U64(id)).unwrap();
        let in_flight = state.in_flight.unwrap();
        assert_eq!(in_flight.nonce.0, attempt.nonce);
        assert_eq!(in_flight.recipient, attempt.recipient);
        assert_eq!(
            in_flight.transfer_amount_usdc_base_units.0,
            attempt.transfer_amount_usdc_base_units
        );
        assert!(state.failed.is_none());
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            liability_before
        );
        assert!(get_created_receipts()
            .iter()
            .flat_map(|receipt| receipt.actions.iter())
            .all(|action| !matches!(
                action,
                MockAction::FunctionCallWeight { method_name, .. }
                    if method_name.as_slice() == b"ft_transfer"
            )));

        set_context("keeper.testnet", 0, NOW + 21);
        let retry = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.retry_circle_payout(U64(id))
        }));
        assert!(
            retry.is_err(),
            "An unresolved malformed preflight must keep the payout locked against retry"
        );
        assert_eq!(
            contract
                .get_circle_payout_state(U64(id))
                .unwrap()
                .in_flight
                .unwrap()
                .nonce
                .0,
            attempt.nonce
        );
    }

    #[test]
    fn storage_preflight_callback_rejects_wrong_nonce_fingerprint_and_stale_replay() {
        let mut contract = new_contract();
        let id = setup_private_two_member_circle(&mut contract, NOW);
        for member in ["creator.testnet", "alice.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }

        set_context("creator.testnet", 0, NOW + 20);
        let _preflight = contract.start_private_round_payout(U64(id));
        let first = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        let fingerprint =
            CentralCircleContract::payout_attempt_fingerprint(id, &contract.usdc_token_id, &first);

        testing_env_with_promise_results(
            callback_context(),
            PromiseResult::Successful(b"null".to_vec()),
        );
        let wrong_nonce = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.on_circle_payout_storage_checked(
                U64(id),
                U64(first.nonce + 1),
                fingerprint.clone(),
            )
        }));
        assert!(
            wrong_nonce.is_err(),
            "A mismatched preflight nonce must be rejected"
        );

        testing_env_with_promise_results(
            callback_context(),
            PromiseResult::Successful(b"null".to_vec()),
        );
        let wrong_fingerprint = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.on_circle_payout_storage_checked(
                U64(id),
                U64(first.nonce),
                format!("{fingerprint}-stale"),
            )
        }));
        assert!(
            wrong_fingerprint.is_err(),
            "A mismatched preflight fingerprint must be rejected"
        );
        assert_eq!(
            contract
                .get_circle_payout_state(U64(id))
                .unwrap()
                .in_flight
                .unwrap()
                .nonce
                .0,
            first.nonce,
            "Rejected callback arguments must not mutate the active attempt"
        );

        // Complete this preflight as a definite unregistered-recipient result.
        testing_env_with_promise_results(
            callback_context(),
            PromiseResult::Successful(b"null".to_vec()),
        );
        let blocked = contract.on_circle_payout_storage_checked(
            U64(id),
            U64(first.nonce),
            fingerprint.clone(),
        );
        assert!(matches!(blocked, PromiseOrValue::Value(false)));
        assert!(contract
            .get_circle_payout_state(U64(id))
            .unwrap()
            .in_flight
            .is_none());

        // The old callback cannot be replayed once its attempt is no longer in flight.
        testing_env_with_promise_results(
            callback_context(),
            PromiseResult::Successful(b"{\"total\":\"1\",\"available\":\"1\"}".to_vec()),
        );
        let replay = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.on_circle_payout_storage_checked(
                U64(id),
                U64(first.nonce),
                fingerprint.clone(),
            )
        }));
        assert!(
            replay.is_err(),
            "A completed preflight callback must not be replayable"
        );

        // After retry, the previous nonce/fingerprint pair must not authorize the new attempt.
        set_context("keeper.testnet", 0, NOW + 22);
        let _retry = contract.retry_circle_payout(U64(id));
        let second = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(second.nonce, first.nonce + 1);
        testing_env_with_promise_results(
            callback_context(),
            PromiseResult::Successful(b"{\"total\":\"1\",\"available\":\"1\"}".to_vec()),
        );
        let stale_after_retry = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.on_circle_payout_storage_checked(U64(id), U64(first.nonce), fingerprint)
        }));
        assert!(
            stale_after_retry.is_err(),
            "A prior attempt callback must not authorize a retried payout"
        );
        assert_eq!(
            contract
                .get_circle_payout_state(U64(id))
                .unwrap()
                .in_flight
                .unwrap()
                .nonce
                .0,
            second.nonce
        );
        assert!(get_created_receipts()
            .iter()
            .flat_map(|receipt| receipt.actions.iter())
            .all(|action| !matches!(
                action,
                MockAction::FunctionCallWeight { method_name, .. }
                    if method_name.as_slice() == b"ft_transfer"
            )));
    }

    #[test]
    fn unregistered_recipient_is_not_sent_usdc_and_failed_attempt_is_retained() {
        let mut contract = new_contract();
        let id = setup_private_two_member_circle(&mut contract, NOW);
        for member in ["creator.testnet", "alice.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }
        let gross = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0
            * 2;
        set_context("creator.testnet", 0, NOW + 20);
        let _preflight = contract.start_private_round_payout(U64(id));
        let attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        let fingerprint = CentralCircleContract::payout_attempt_fingerprint(
            id,
            &contract.usdc_token_id,
            &attempt,
        );
        testing_env_with_promise_results(
            callback_context(),
            PromiseResult::Successful(b"null".to_vec()),
        );
        let result =
            contract.on_circle_payout_storage_checked(U64(id), U64(attempt.nonce), fingerprint);
        assert!(matches!(result, PromiseOrValue::Value(false)));
        let state = contract.get_circle_payout_state(U64(id)).unwrap();
        assert!(state.in_flight.is_none());
        assert_eq!(state.failed.unwrap().nonce.0, attempt.nonce);
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            gross
        );
        assert!(get_created_receipts()
            .iter()
            .flat_map(|receipt| receipt.actions.iter())
            .all(|action| !matches!(
                action,
                MockAction::FunctionCallWeight { method_name, .. }
                    if method_name.as_slice() == b"ft_transfer"
            )));
    }

    #[test]
    fn missing_payout_callback_leaves_attempt_in_flight_and_blocks_retry() {
        let mut contract = new_contract();
        let id = setup_private_two_member_circle(&mut contract, NOW);
        for member in ["creator.testnet", "alice.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }
        let gross = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0
            * 2;
        set_context("creator.testnet", 0, NOW + 20);
        let _preflight = contract.start_private_round_payout(U64(id));
        let attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();

        // No callback was delivered. near-sdk 5.17.2 models only Successful/Failed
        // results inside callbacks; absence of a callback is represented by leaving
        // this persisted in-flight attempt untouched, not by inventing a third result.
        set_context("keeper.testnet", 0, NOW + 30);
        let retry = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.retry_circle_payout(U64(id))
        }));
        assert!(
            retry.is_err(),
            "A missing callback must not be treated as failure"
        );
        let state = contract.get_circle_payout_state(U64(id)).unwrap();
        let in_flight = state.in_flight.unwrap();
        assert_eq!(in_flight.nonce.0, attempt.nonce);
        assert_eq!(in_flight.attempt_fingerprint.len(), 64);
        assert!(state.failed.is_none());
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            gross,
            "No principal is released without a successful final callback"
        );
    }

    #[test]
    fn public_cycle_distributes_verified_contribution_totals_and_pays_sequentially() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context("alice.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        set_context("creator.testnet", 5, NOW + 3);
        contract.start_circle(U64(id), vec![U64(NOW + 100), U64(NOW + 200)]);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;

        // Both members contribute in round zero.
        for member in ["creator.testnet", "alice.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 0, NOW + 20);
        assert!(!contract.advance_public_round(U64(id)));

        // Only the creator contributes in round one. Alice's approved default exit
        // is paid immediately from her one verified contribution before progression.
        set_context("creator.testnet", 1, NOW + 25);
        contract.contribute(U64(id));
        set_context("keeper.testnet", 5, NOW + 201);
        let scan = contract.record_missed_contributions(U64(id), None);
        assert!(scan.complete);
        assert_eq!(scan.missed_count, 1);
        set_context("creator.testnet", 1, NOW + 202);
        assert!(contract.vote_remove_defaulted_member(U64(id), 1, account("alice.testnet"), true));
        let exit_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        let exit_fee = CentralCircleContract::basis_point_amount(amount, DISTRIBUTION_FEE_BPS);
        let exit_penalty =
            CentralCircleContract::basis_point_amount(amount, PUBLIC_DEFAULT_PENALTY_BPS);
        assert_eq!(exit_attempt.kind, PayoutKind::PublicDefaultExit);
        assert_eq!(exit_attempt.recipient, account("alice.testnet"));
        assert_eq!(exit_attempt.gross_amount_usdc_base_units, amount);
        assert_eq!(exit_attempt.penalty_amount_usdc_base_units, exit_penalty);
        assert_eq!(exit_attempt.distribution_fee_usdc_base_units, exit_fee);
        let storage_before_exit_callback = env::storage_usage();
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &exit_attempt));
        set_context_after_callback("keeper.testnet", NOW + 203, storage_before_exit_callback);
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            amount * 2
        );
        assert_eq!(
            contract
                .get_contract_config()
                .distribution_fee_liability_usdc_base_units
                .0,
            exit_fee
        );
        assert!(contract
            .get_circle_member(U64(id), account("alice.testnet"))
            .is_none());

        set_context("keeper.testnet", 0, NOW + 203);
        assert!(contract.advance_public_round(U64(id)));

        assert_eq!(
            contract
                .get_member_total_contributions(U64(id), account("creator.testnet"))
                .0,
            amount * 2
        );
        assert_eq!(
            contract
                .get_member_total_contributions(U64(id), account("alice.testnet"))
                .0,
            amount
        );
        let summary = contract.get_circle(U64(id)).unwrap();
        assert_eq!(summary.status, CircleStatus::SettlementReady);

        set_context("keeper.testnet", 0, NOW + 204);
        let _first = contract.continue_public_distribution(U64(id));
        let first = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        let first_fee = CentralCircleContract::basis_point_amount(amount * 2, DISTRIBUTION_FEE_BPS);
        assert_eq!(first.recipient, account("creator.testnet"));
        assert_eq!(first.gross_amount_usdc_base_units, amount * 2);
        assert_eq!(first.penalty_amount_usdc_base_units, 0);
        assert_eq!(first.distribution_fee_usdc_base_units, first_fee);
        assert_eq!(
            first.transfer_amount_usdc_base_units,
            amount * 2 - first_fee
        );
        let storage_before_first_callback = env::storage_usage();
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &first));
        set_context_after_callback("keeper.testnet", NOW + 204, storage_before_first_callback);
        let config = contract.get_contract_config();
        assert_eq!(config.contribution_liability_usdc_base_units.0, 0);
        assert_eq!(config.penalty_liability_usdc_base_units.0, exit_penalty);
        assert_eq!(
            config.distribution_fee_liability_usdc_base_units.0,
            exit_fee + first_fee
        );
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().status,
            CircleStatus::Completed
        );
        assert!(contract
            .get_circle_member(U64(id), account("alice.testnet"))
            .is_none());
    }

    #[test]
    fn public_default_penalty_is_applied_once_at_distribution_and_exit_is_settled() {
        let mut contract = new_contract();
        let id = setup_public_three_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;
        for member in ["creator.testnet", "alice.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 0, NOW + 20);
        assert!(!contract.advance_public_round(U64(id)));
        for member in ["creator.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 25);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 5, NOW + 200);
        let scan = contract.record_missed_contributions(U64(id), None);
        assert!(scan.complete);
        assert_eq!(scan.missed_count, 1);
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.advance_public_round(U64(id))
        }));
        assert!(
            blocked.is_err(),
            "A public round cannot advance with a pending default vote"
        );
        set_context("creator.testnet", 1, NOW + 201);
        assert!(!contract.vote_remove_defaulted_member(U64(id), 1, account("alice.testnet"), true));
        set_context("bob.testnet", 1, NOW + 202);
        assert!(contract.vote_remove_defaulted_member(U64(id), 1, account("alice.testnet"), true));
        let exit_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        let exit_fee = CentralCircleContract::basis_point_amount(amount, DISTRIBUTION_FEE_BPS);
        let exit_penalty =
            CentralCircleContract::basis_point_amount(amount, PUBLIC_DEFAULT_PENALTY_BPS);
        let pending_exit = contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .unwrap();
        assert_eq!(pending_exit.status, ExitSettlementStatus::PendingSettlement);
        assert_eq!(pending_exit.gross_claim_usdc_base_units.0, amount);
        assert_eq!(pending_exit.penalty_usdc_base_units.0, exit_penalty);
        assert_eq!(exit_attempt.kind, PayoutKind::PublicDefaultExit);
        assert_eq!(exit_attempt.penalty_amount_usdc_base_units, exit_penalty);
        assert_eq!(exit_attempt.distribution_fee_usdc_base_units, exit_fee);
        assert_eq!(
            exit_attempt.transfer_amount_usdc_base_units,
            amount - exit_penalty - exit_fee
        );
        let storage_before_exit_callback = env::storage_usage();
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &exit_attempt));
        set_context_after_callback("keeper.testnet", NOW + 222, storage_before_exit_callback);
        let settled_exit = contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .unwrap();
        assert_eq!(settled_exit.status, ExitSettlementStatus::Settled);
        assert_eq!(settled_exit.penalty_bps, 500);
        assert_eq!(settled_exit.penalty_usdc_base_units.0, exit_penalty);
        assert!(contract
            .get_circle_member(U64(id), account("alice.testnet"))
            .is_none());
        assert_eq!(contract.contribution_liability_usdc_base_units, amount * 4);
        assert_eq!(contract.penalty_liability_usdc_base_units, exit_penalty);
        assert_eq!(
            contract.distribution_fee_liability_usdc_base_units,
            exit_fee
        );

        set_context("keeper.testnet", 0, NOW + 203);
        assert!(!contract.advance_public_round(U64(id)));
        for member in ["creator.testnet", "bob.testnet"] {
            set_context(member, 1, NOW + 210);
            contract.contribute(U64(id));
        }
        set_context("keeper.testnet", 0, NOW + 220);
        assert!(contract.advance_public_round(U64(id)));

        set_context("keeper.testnet", 0, NOW + 221);
        let _creator_payout = contract.continue_public_distribution(U64(id));
        let creator_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(creator_attempt.recipient, account("creator.testnet"));
        assert_eq!(creator_attempt.gross_amount_usdc_base_units, amount * 3);
        assert_eq!(
            contract
                .get_circle(U64(id))
                .unwrap()
                .public_distribution_remaining_usdc_base_units
                .0,
            amount * 6
        );
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(
            &mut contract,
            id,
            &creator_attempt
        ));

        set_context("keeper.testnet", 0, NOW + 222);
        let _bob_payout = contract.continue_public_distribution(U64(id));
        let bob_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(bob_attempt.recipient, account("bob.testnet"));
        assert_eq!(bob_attempt.gross_amount_usdc_base_units, amount * 3);
        let storage_before_final_bob_callback = env::storage_usage();
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &bob_attempt));
        set_context_after_callback(
            "keeper.testnet",
            NOW + 224,
            storage_before_final_bob_callback,
        );
        assert!(contract
            .get_circle_member(U64(id), account("alice.testnet"))
            .is_none());
        let expected_distribution_fees = exit_fee
            + creator_attempt.distribution_fee_usdc_base_units
            + bob_attempt.distribution_fee_usdc_base_units;
        assert_eq!(contract.contribution_liability_usdc_base_units, 0);
        assert_eq!(
            contract.penalty_liability_usdc_base_units, exit_penalty,
            "The penalty remains protected separately and is not charged a second time"
        );
        assert_eq!(
            contract.distribution_fee_liability_usdc_base_units,
            expected_distribution_fees
        );
    }
    #[test]
    fn new_circle_sets_fixed_025_usdc_entry_fee_without_charging_near_storage() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        let circle = contract.get_circle(U64(id)).unwrap();
        assert_eq!(circle.entry_fee_usdc_base_units.0, 250_000);
        assert_eq!(circle.entry_fee_total_usdc_base_units.0, 0);
        assert_eq!(circle.entry_fee_paid_count, 0);
        assert_eq!(circle.entry_fee_slot_count, 1);
        assert!(contract
            .get_entry_fee_payment(U64(id), account("creator.testnet"))
            .is_none());
        assert_eq!(
            contract
                .get_contract_config()
                .entry_fee_liability_usdc_base_units
                .0,
            0
        );
        assert_eq!(
            contract
                .get_storage_deposit(U64(id), account("owner.testnet"))
                .unwrap()
                .total_paid_yocto,
            contract
                .get_storage_deposit(U64(id), account("owner.testnet"))
                .unwrap()
                .storage_locked_yocto,
            "AjoCircle's pre-funded NEAR balance covers storage; USDC fee accounting is separate"
        );
    }

    #[test]
    fn entry_fee_is_paid_separately_via_nep141_and_remains_once_after_prestart_rejoin() {
        let mut contract = new_contract();
        let fee = USDC_ENTRY_FEE_BASE_UNITS;
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);

        set_context(USDC_TOKEN_ID, 0, NOW + 1);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("creator.testnet"),
                U128(fee),
                usdc_entry_fee_message(id),
            )),
            0
        );
        let creator_receipt = contract
            .get_entry_fee_payment(U64(id), account("creator.testnet"))
            .unwrap();
        assert_eq!(creator_receipt.amount_usdc_base_units.0, fee);

        set_context("alice.testnet", 2, NOW + 2);
        contract.join_public_circle(U64(id));
        assert!(
            contract
                .get_entry_fee_payment(U64(id), account("alice.testnet"))
                .is_none(),
            "Joining creates a reserved receipt slot, not a paid fee"
        );
        assert_eq!(
            contract
                .get_storage_deposit(U64(id), account("owner.testnet"))
                .unwrap()
                .total_paid_yocto,
            contract
                .get_storage_deposit(U64(id), account("owner.testnet"))
                .unwrap()
                .storage_locked_yocto,
            "AjoCircle funds member storage; the member has no NEAR payer record"
        );

        set_context(USDC_TOKEN_ID, 0, NOW + 3);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("alice.testnet"),
                U128(fee),
                usdc_entry_fee_message(id),
            )),
            0
        );
        let first_payment = contract
            .get_entry_fee_payment(U64(id), account("alice.testnet"))
            .unwrap();
        assert_eq!(first_payment.amount_usdc_base_units.0, fee);
        assert_eq!(first_payment.paid_at_ns.0, NOW + 3);

        set_context("alice.testnet", 0, NOW + 4);
        assert!(contract.request_member_exit(U64(id)));
        set_context("alice.testnet", 2, NOW + 5);
        contract.join_public_circle(U64(id));
        let after_rejoin = contract.get_circle(U64(id)).unwrap();
        assert_eq!(after_rejoin.entry_fee_paid_count, 2);
        assert_eq!(after_rejoin.entry_fee_slot_count, 2);
        assert_eq!(after_rejoin.entry_fee_total_usdc_base_units.0, fee * 2);
        let config = contract.get_contract_config();
        assert_eq!(config.entry_fee_liability_usdc_base_units.0, fee * 2);
        assert_eq!(
            contract
                .get_entry_fee_payment(U64(id), account("alice.testnet"))
                .unwrap()
                .paid_at_ns
                .0,
            NOW + 3,
            "Rejoining must not charge or replace the original fee receipt"
        );
    }

    #[test]
    fn private_invitation_entry_fee_is_paid_by_invited_wallet_via_nep141() {
        let mut contract = new_contract();
        let fee = USDC_ENTRY_FEE_BASE_UNITS;
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Private, 2);

        set_context(USDC_TOKEN_ID, 0, NOW + 1);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("creator.testnet"),
                U128(fee),
                usdc_entry_fee_message(id),
            )),
            0
        );
        set_context("creator.testnet", 2, NOW + 2);
        contract.invite_private_member(U64(id), account("invitee.testnet"));
        assert!(
            contract
                .get_entry_fee_payment(U64(id), account("invitee.testnet"))
                .is_none(),
            "Inviting a wallet does not pay its entry fee"
        );

        set_context("invitee.testnet", 2, NOW + 3);
        contract.accept_private_invitation(U64(id));
        assert!(
            contract
                .get_entry_fee_payment(U64(id), account("invitee.testnet"))
                .is_none(),
            "Accepting the invitation allocates membership storage; fee remains separately payable"
        );
        set_context(USDC_TOKEN_ID, 0, NOW + 4);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("invitee.testnet"),
                U128(fee),
                usdc_entry_fee_message(id),
            )),
            0
        );
        assert_eq!(
            contract
                .get_entry_fee_payment(U64(id), account("invitee.testnet"))
                .unwrap()
                .amount_usdc_base_units
                .0,
            fee
        );
        assert_eq!(
            contract
                .get_contract_config()
                .entry_fee_liability_usdc_base_units
                .0,
            fee * 2
        );
    }

    #[test]
    fn voluntary_private_exit_is_settled_only_after_its_scheduled_usdc_payout_callback() {
        let mut contract = new_contract();
        let id = setup_private_two_member_circle(&mut contract, NOW);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;

        for member in ["creator.testnet", "alice.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }

        set_context("alice.testnet", 1, NOW + 20);
        assert!(!contract.request_member_exit(U64(id)));
        let pending = contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .unwrap();
        assert_eq!(pending.status, ExitSettlementStatus::PendingSettlement);
        assert_eq!(pending.gross_claim_usdc_base_units.0, 0);

        set_context("creator.testnet", 0, NOW + 21);
        let first_promise = contract.start_private_round_payout(U64(id));
        drop(first_promise);
        let first_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(first_attempt.recipient, account("creator.testnet"));
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &first_attempt));
        assert_eq!(
            contract
                .get_member_exit(U64(id), account("alice.testnet"))
                .unwrap()
                .status,
            ExitSettlementStatus::PendingSettlement
        );

        set_context("creator.testnet", 1, NOW + 30);
        contract.contribute(U64(id));
        set_context("creator.testnet", 0, NOW + 31);
        let second_promise = contract.start_private_round_payout(U64(id));
        drop(second_promise);
        let second_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(second_attempt.recipient, account("alice.testnet"));
        assert_eq!(second_attempt.gross_amount_usdc_base_units, amount);
        assert_eq!(second_attempt.penalty_amount_usdc_base_units, 0);
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &second_attempt));

        let settled = contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .unwrap();
        assert_eq!(settled.status, ExitSettlementStatus::Settled);
        assert_eq!(settled.gross_claim_usdc_base_units.0, amount);
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            0
        );
    }

    #[test]
    fn voluntary_public_exit_claim_is_paid_only_after_the_final_usdc_distribution_callback() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context("alice.testnet", 2, NOW + 1);
        contract.join_public_circle(U64(id));
        set_context("creator.testnet", 5, NOW + 3);
        contract.start_circle(U64(id), vec![U64(NOW + 100), U64(NOW + 200)]);
        let amount = contract
            .get_circle(U64(id))
            .unwrap()
            .contribution_amount_usdc_base_units
            .0;

        for member in ["creator.testnet", "alice.testnet"] {
            set_context(member, 1, NOW + 10);
            contract.contribute(U64(id));
        }
        set_context("alice.testnet", 1, NOW + 20);
        assert!(!contract.request_member_exit(U64(id)));
        let pending = contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .unwrap();
        assert_eq!(pending.status, ExitSettlementStatus::PendingSettlement);
        assert_eq!(pending.gross_claim_usdc_base_units.0, amount);
        assert_eq!(pending.penalty_usdc_base_units.0, 0);

        set_context("keeper.testnet", 0, NOW + 30);
        assert!(!contract.advance_public_round(U64(id)));
        set_context("creator.testnet", 1, NOW + 120);
        contract.contribute(U64(id));
        set_context("keeper.testnet", 5, NOW + 201);
        let scan = contract.record_missed_contributions(U64(id), None);
        assert!(scan.complete);
        assert_eq!(scan.missed_count, 0);
        assert!(contract.advance_public_round(U64(id)));
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().status,
            CircleStatus::SettlementReady
        );

        set_context("keeper.testnet", 0, NOW + 202);
        let first_promise = contract.continue_public_distribution(U64(id));
        drop(first_promise);
        let first_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(first_attempt.recipient, account("creator.testnet"));
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &first_attempt));
        assert_eq!(
            contract
                .get_member_exit(U64(id), account("alice.testnet"))
                .unwrap()
                .status,
            ExitSettlementStatus::PendingSettlement
        );

        set_context("keeper.testnet", 0, NOW + 203);
        let second_promise = contract.continue_public_distribution(U64(id));
        drop(second_promise);
        let second_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(second_attempt.recipient, account("alice.testnet"));
        assert_eq!(second_attempt.gross_amount_usdc_base_units, amount);
        assert_eq!(second_attempt.penalty_amount_usdc_base_units, 0);
        assert_eq!(
            second_attempt.distribution_fee_usdc_base_units,
            CentralCircleContract::basis_point_amount(amount, DISTRIBUTION_FEE_BPS)
        );
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &second_attempt));

        let settled = contract
            .get_member_exit(U64(id), account("alice.testnet"))
            .unwrap();
        assert_eq!(settled.status, ExitSettlementStatus::Settled);
        assert_eq!(settled.gross_claim_usdc_base_units.0, amount);
        assert_eq!(settled.penalty_usdc_base_units.0, 0);
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            0
        );
    }
    #[test]
    fn cancelled_entry_fee_refund_retries_after_confirmed_failure_and_includes_former_member() {
        let mut contract = new_contract();
        let fee = USDC_ENTRY_FEE_BASE_UNITS;
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 2);
        set_context(USDC_TOKEN_ID, 0, NOW + 1);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("creator.testnet"),
                U128(fee),
                usdc_entry_fee_message(id)
            )),
            0
        );
        set_context("alice.testnet", 2, NOW + 2);
        contract.join_public_circle(U64(id));
        set_context(USDC_TOKEN_ID, 0, NOW + 3);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("alice.testnet"),
                U128(fee),
                usdc_entry_fee_message(id)
            )),
            0
        );

        // Alice leaves before start, but her paid entry fee remains in the historical payer index.
        set_context("alice.testnet", 0, NOW + 4);
        assert!(contract.request_member_exit(U64(id)));
        set_context("creator.testnet", 0, NOW + 5);
        contract.cancel_unstarted_circle(U64(id));
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().entry_fee_slot_count,
            2
        );
        assert_eq!(contract.entry_fee_liability_usdc_base_units, fee * 2);

        set_context("keeper.testnet", 0, NOW + 6);
        let first_promise = contract.continue_cancelled_circle_entry_fee_refunds(U64(id));
        assert!(matches!(first_promise, PromiseOrValue::Promise(_)));
        let first_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(first_attempt.kind, PayoutKind::EntryFeeRefund);
        assert_eq!(first_attempt.recipient, account("creator.testnet"));
        assert_eq!(first_attempt.gross_amount_usdc_base_units, fee);
        assert_eq!(first_attempt.penalty_amount_usdc_base_units, 0);
        assert_eq!(first_attempt.distribution_fee_usdc_base_units, 0);

        // An explicit failed transfer preserves the original fee liability and is retryable.
        testing_env_with_promise_results(callback_context(), PromiseResult::Failed);
        assert!(!complete_payout_for_test(&mut contract, id, &first_attempt));
        assert_eq!(contract.entry_fee_liability_usdc_base_units, fee * 2);
        assert!(
            !contract
                .get_entry_fee_payment(U64(id), account("creator.testnet"))
                .unwrap()
                .refunded
        );

        set_context("keeper.testnet", 0, NOW + 7);
        let retry_promise = contract.retry_circle_payout(U64(id));
        drop(retry_promise);
        let retry_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(retry_attempt.kind, PayoutKind::EntryFeeRefund);
        assert_eq!(retry_attempt.nonce, first_attempt.nonce + 1);
        assert_eq!(retry_attempt.retry_count, 1);
        assert_eq!(retry_attempt.recipient, first_attempt.recipient);
        assert_eq!(
            retry_attempt.gross_amount_usdc_base_units,
            first_attempt.gross_amount_usdc_base_units
        );
        assert_eq!(
            retry_attempt.transfer_amount_usdc_base_units,
            first_attempt.transfer_amount_usdc_base_units
        );
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &retry_attempt));
        assert_eq!(contract.entry_fee_liability_usdc_base_units, fee);
        assert!(
            contract
                .get_entry_fee_payment(U64(id), account("creator.testnet"))
                .unwrap()
                .refunded
        );

        // The next historical slot is Alice, even though she is no longer an active member.
        set_context("keeper.testnet", 0, NOW + 8);
        let second_promise = contract.continue_cancelled_circle_entry_fee_refunds(U64(id));
        assert!(matches!(second_promise, PromiseOrValue::Promise(_)));
        let second_attempt = contract.circles.get(&id).unwrap().payout_in_flight.unwrap();
        assert_eq!(second_attempt.kind, PayoutKind::EntryFeeRefund);
        assert_eq!(second_attempt.recipient, account("alice.testnet"));
        assert_eq!(second_attempt.gross_amount_usdc_base_units, fee);
        testing_env_with_promise_results(callback_context(), PromiseResult::Successful(Vec::new()));
        assert!(complete_payout_for_test(&mut contract, id, &second_attempt));
        assert_eq!(contract.entry_fee_liability_usdc_base_units, 0);
        assert!(
            contract
                .get_entry_fee_payment(U64(id), account("alice.testnet"))
                .unwrap()
                .refunded
        );

        set_context("keeper.testnet", 0, NOW + 9);
        assert!(matches!(
            contract.continue_cancelled_circle_entry_fee_refunds(U64(id)),
            PromiseOrValue::Value(true)
        ));
        assert!(
            contract
                .get_circle(U64(id))
                .unwrap()
                .entry_fee_refund_complete
        );
    }
    #[test]
    fn cancelled_circle_keeps_paid_usdc_entry_fee_liability_until_segment3_refund() {
        let mut contract = new_contract();
        let fee = USDC_ENTRY_FEE_BASE_UNITS;
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 3);

        set_context(USDC_TOKEN_ID, 0, NOW + 1);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("creator.testnet"),
                U128(fee),
                usdc_entry_fee_message(id),
            )),
            0
        );
        set_context("alice.testnet", 2, NOW + 2);
        contract.join_public_circle(U64(id));
        set_context(USDC_TOKEN_ID, 0, NOW + 3);
        assert_eq!(
            unused_ft_amount(contract.ft_on_transfer(
                account("alice.testnet"),
                U128(fee),
                usdc_entry_fee_message(id),
            )),
            0
        );
        assert_eq!(contract.entry_fee_liability_usdc_base_units, fee * 2);

        set_context("alice.testnet", 0, NOW + 4);
        assert!(contract.request_member_exit(U64(id)));
        set_context("creator.testnet", 0, NOW + 5);
        contract.cancel_unstarted_circle(U64(id));
        let cancelled = contract.get_circle(U64(id)).unwrap();
        assert_eq!(cancelled.entry_fee_slot_count, 2);
        assert_eq!(cancelled.entry_fee_paid_count, 2);
        assert_eq!(cancelled.entry_fee_total_usdc_base_units.0, fee * 2);
        assert!(!cancelled.entry_fee_refund_complete);
        assert_eq!(contract.entry_fee_liability_usdc_base_units, fee * 2);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                contract.continue_circle_cleanup(U64(id))
            }))
            .is_err(),
            "Storage cleanup must wait until the USDC fee refund path is available"
        );
    }
    #[test]
    fn central_multi_circle_storage_scale_benchmark() {
        const CIRCLES: u32 = 100;
        const THREE_MEMBER_CONTRIBUTION: u128 = 100_000_000_000_000_000_000_000;
        let mut contract = new_contract();
        let mut cumulative_storage_bytes = 0u64;
        let mut cumulative_mocked_gas = 0u64;

        // The near-sdk test context resets per-transaction counters, so collect each
        // operation's storage/gas delta before switching to the next wallet context.
        let set_scale_context = |predecessor: &str, _deposit_near: u128, timestamp: u64| {
            let mut builder = VMContextBuilder::new();
            builder
                .current_account_id(account("ajocircle.fake"))
                .signer_account_id(account("owner.testnet"))
                .predecessor_account_id(account(predecessor))
                .account_balance(NearToken::from_near(1_000_000))
                .storage_usage(env::storage_usage())
                .attached_deposit(NearToken::from_yoctonear(0))
                .block_timestamp(timestamp);
            testing_env!(builder.build());
        };

        for index in 0..CIRCLES {
            let timestamp = NOW + u64::from(index) * 10;
            set_scale_context("scalecreator.testnet", 5, timestamp);
            let storage_before = env::storage_usage();
            let gas_before = env::used_gas().as_gas();
            let circle_id = contract
                .create_circle(
                    CircleMode::Public,
                    2,
                    3,
                    U128(THREE_MEMBER_CONTRIBUTION),
                    U64(DEADLINE + u64::from(index) * 1_000),
                )
                .0;
            cumulative_storage_bytes = cumulative_storage_bytes
                .checked_add(env::storage_usage().saturating_sub(storage_before))
                .expect("Benchmark storage counter overflow");
            cumulative_mocked_gas = cumulative_mocked_gas
                .checked_add(env::used_gas().as_gas().saturating_sub(gas_before))
                .expect("Benchmark gas counter overflow");

            for slot in 0..2u32 {
                let member = format!("circle{:03}member{}.testnet", index, slot);
                set_scale_context(&member, 2, timestamp + u64::from(slot) + 1);
                let storage_before = env::storage_usage();
                let gas_before = env::used_gas().as_gas();
                contract.join_public_circle(U64(circle_id));
                cumulative_storage_bytes = cumulative_storage_bytes
                    .checked_add(env::storage_usage().saturating_sub(storage_before))
                    .expect("Benchmark storage counter overflow");
                cumulative_mocked_gas = cumulative_mocked_gas
                    .checked_add(env::used_gas().as_gas().saturating_sub(gas_before))
                    .expect("Benchmark gas counter overflow");
            }

            let completed = index + 1;
            if [1, 10, 50, 100].contains(&completed) {
                println!(
                    "AJOCIRCLE_SCALE circles={} members={} storage_bytes_total={} average_bytes_per_circle={} mocked_host_gas_units_total={} average_mocked_host_gas_per_circle={}",
                    completed,
                    completed * 3,
                    cumulative_storage_bytes,
                    cumulative_storage_bytes / u64::from(completed),
                    cumulative_mocked_gas,
                    cumulative_mocked_gas / u64::from(completed)
                );
            }
        }

        set_scale_context("scalecreator.testnet", 0, NOW + 9_000);
        let creator_page_one = contract.get_my_circles(None, Some(50));
        let creator_page_two = contract.get_my_circles(Some(50), Some(50));
        assert_eq!(creator_page_one.len(), 50);
        assert_eq!(creator_page_two.len(), 50);
        assert_eq!(creator_page_one[0].circle_id.0, 1);
        assert_eq!(creator_page_two[49].circle_id.0, 100);

        let mut large_circle_storage_bytes = 0u64;
        let mut large_circle_mocked_gas = 0u64;
        set_scale_context("largecreator.testnet", 5, NOW + 10_000);
        let storage_before = env::storage_usage();
        let gas_before = env::used_gas().as_gas();
        let large_circle_id = contract
            .create_circle(
                CircleMode::Public,
                2,
                MAX_MEMBERS_PER_CIRCLE,
                U128(THREE_MEMBER_CONTRIBUTION),
                U64(DEADLINE + 1_000_000),
            )
            .0;
        large_circle_storage_bytes += env::storage_usage().saturating_sub(storage_before);
        large_circle_mocked_gas += env::used_gas().as_gas().saturating_sub(gas_before);

        for index in 0..(MAX_MEMBERS_PER_CIRCLE - 1) {
            let member = format!("largemember{:03}.testnet", index);
            set_scale_context(&member, 2, NOW + 10_001 + u64::from(index));
            let storage_before = env::storage_usage();
            let gas_before = env::used_gas().as_gas();
            contract.join_public_circle(U64(large_circle_id));
            large_circle_storage_bytes += env::storage_usage().saturating_sub(storage_before);
            large_circle_mocked_gas += env::used_gas().as_gas().saturating_sub(gas_before);
        }
        let large_summary = contract.get_circle(U64(large_circle_id)).unwrap();
        assert_eq!(large_summary.member_count, MAX_MEMBERS_PER_CIRCLE);
        assert_eq!(large_summary.status, CircleStatus::RegistrationClosed);
        println!(
            "AJOCIRCLE_SCALE single_circle_members={} storage_bytes_total={} mocked_host_gas_units_total={}",
            large_summary.member_count,
            large_circle_storage_bytes,
            large_circle_mocked_gas
        );
    }

    #[test]
    #[ignore = "manual full-cycle storage benchmark; not a routine unit test"]
    fn central_multi_circle_three_member_full_cycle_storage_benchmark() {
        const MEMBERS: [&str; 3] = ["creator.testnet", "alice.testnet", "bob.testnet"];
        const CONTRIBUTION: u128 = 100_000_000_000_000_000_000_000;
        let mut contract = new_contract();

        // Measure each operation after establishing that transaction's context.
        set_context(MEMBERS[0], 5, NOW);
        let before_create = env::storage_usage();
        let circle_id = contract
            .create_circle(CircleMode::Public, 2, 3, U128(CONTRIBUTION), U64(DEADLINE))
            .0;
        let mut registration_bytes = env::storage_usage() as i64 - before_create as i64;

        set_context(MEMBERS[1], 2, NOW + 1);
        let before_join_alice = env::storage_usage();
        contract.join_public_circle(U64(circle_id));
        registration_bytes += env::storage_usage() as i64 - before_join_alice as i64;

        set_context(MEMBERS[2], 2, NOW + 2);
        let before_join_bob = env::storage_usage();
        contract.join_public_circle(U64(circle_id));
        registration_bytes += env::storage_usage() as i64 - before_join_bob as i64;

        set_context(MEMBERS[0], 5, NOW + 3);
        let before_start = env::storage_usage();
        contract.start_circle(
            U64(circle_id),
            vec![U64(NOW + 100), U64(NOW + 200), U64(NOW + 300)],
        );
        let start_bytes = env::storage_usage() as i64 - before_start as i64;

        let mut contribution_bytes = 0i64;
        let mut round_advance_bytes = 0i64;
        for round in 0..3u32 {
            for (slot, member) in MEMBERS.iter().enumerate() {
                set_context(member, 1, NOW + 10 + u64::from(round) * 20 + slot as u64);
                let before = env::storage_usage();
                contract.contribute(U64(circle_id));
                contribution_bytes += env::storage_usage() as i64 - before as i64;
            }

            set_context("keeper.testnet", 0, NOW + 20 + u64::from(round) * 20);
            let before_advance = env::storage_usage();
            let settlement_ready = contract.advance_public_round(U64(circle_id));
            round_advance_bytes += env::storage_usage() as i64 - before_advance as i64;
            assert_eq!(settlement_ready, round == 2);
        }

        let mut distribution_start_bytes = 0i64;
        let mut payout_callback_bytes = 0i64;
        for index in 0..MEMBERS.len() {
            set_context("keeper.testnet", 0, NOW + 400 + index as u64);
            let before_start_payout = env::storage_usage();
            contract.continue_public_distribution(U64(circle_id));
            distribution_start_bytes += env::storage_usage() as i64 - before_start_payout as i64;

            let attempt = contract
                .circles
                .get(&circle_id)
                .and_then(|circle| circle.payout_in_flight)
                .expect("Expected one in-flight public distribution");
            testing_env_with_promise_results(
                callback_context(),
                PromiseResult::Successful(Vec::new()),
            );
            let before_callback = env::storage_usage();
            assert!(complete_payout_for_test(&mut contract, circle_id, &attempt));
            payout_callback_bytes += env::storage_usage() as i64 - before_callback as i64;
        }

        let final_circle = contract.get_circle(U64(circle_id)).unwrap();
        assert_eq!(final_circle.status, CircleStatus::Completed);
        assert_eq!(final_circle.member_count, 3);
        assert_eq!(
            contract
                .get_contract_config()
                .contribution_liability_usdc_base_units
                .0,
            0
        );

        let total_net_storage_bytes = registration_bytes
            + start_bytes
            + contribution_bytes
            + round_advance_bytes
            + distribution_start_bytes
            + payout_callback_bytes;
        assert!(
            total_net_storage_bytes > 0,
            "Completed cycle should retain net storage"
        );
        let storage_cost_yocto = u128::try_from(total_net_storage_bytes)
            .expect("Net storage bytes cannot be negative")
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("Full-cycle storage cost overflow");
        println!(
            "AJOCIRCLE_FULL_CYCLE circle_id={} members=3 rounds=3 contribution_per_member_round_yocto={} registration_net_bytes={} start_net_bytes={} nine_contribution_net_bytes={} three_round_advance_net_bytes={} three_distribution_start_net_bytes={} three_payout_callback_net_bytes={} total_net_storage_bytes={} storage_cost_yocto={} storage_byte_price_yocto={}",
            circle_id,
            CONTRIBUTION,
            registration_bytes,
            start_bytes,
            contribution_bytes,
            round_advance_bytes,
            distribution_start_bytes,
            payout_callback_bytes,
            total_net_storage_bytes,
            storage_cost_yocto,
            env::storage_byte_cost().as_yoctonear()
        );
    }

    #[test]
    #[ignore = "manual ten-cycle storage benchmark; not a routine unit test"]
    fn central_multi_circle_ten_three_member_full_cycles_storage_benchmark() {
        const CYCLES: u64 = 10;
        const CONTRIBUTION: u128 = 100_000_000_000_000_000_000_000;
        let mut contract = new_contract();
        let mut registration_bytes = 0i64;
        let mut start_bytes = 0i64;
        let mut contribution_bytes = 0i64;
        let mut round_advance_bytes = 0i64;
        let mut distribution_start_bytes = 0i64;
        let mut payout_callback_bytes = 0i64;

        for cycle_index in 0..CYCLES {
            let creator = "creator.testnet".to_string();
            let alice = format!("alice{:02}.testnet", cycle_index);
            let bob = format!("bob{:02}.testnet", cycle_index);
            let members = [creator, alice, bob];
            let base = NOW + cycle_index * 1_000;

            set_context(&members[0], 5, base);
            let before_create = env::storage_usage();
            let circle_id = contract
                .create_circle(
                    CircleMode::Public,
                    2,
                    3,
                    U128(CONTRIBUTION),
                    U64(DEADLINE + cycle_index * 10_000),
                )
                .0;
            registration_bytes += env::storage_usage() as i64 - before_create as i64;

            set_context(&members[1], 2, base + 1);
            let before_join_alice = env::storage_usage();
            contract.join_public_circle(U64(circle_id));
            registration_bytes += env::storage_usage() as i64 - before_join_alice as i64;

            set_context(&members[2], 2, base + 2);
            let before_join_bob = env::storage_usage();
            contract.join_public_circle(U64(circle_id));
            registration_bytes += env::storage_usage() as i64 - before_join_bob as i64;

            set_context(&members[0], 5, base + 3);
            let before_start = env::storage_usage();
            contract.start_circle(
                U64(circle_id),
                vec![U64(base + 100), U64(base + 200), U64(base + 300)],
            );
            start_bytes += env::storage_usage() as i64 - before_start as i64;

            for round in 0..3u64 {
                for (slot, member) in members.iter().enumerate() {
                    set_context(member, 1, base + 10 + round * 20 + slot as u64);
                    let before = env::storage_usage();
                    contract.contribute(U64(circle_id));
                    contribution_bytes += env::storage_usage() as i64 - before as i64;
                }

                set_context("keeper.testnet", 0, base + 20 + round * 20);
                let before_advance = env::storage_usage();
                let settlement_ready = contract.advance_public_round(U64(circle_id));
                round_advance_bytes += env::storage_usage() as i64 - before_advance as i64;
                assert_eq!(settlement_ready, round == 2);
            }

            for payout_index in 0..members.len() {
                set_context("keeper.testnet", 0, base + 400 + payout_index as u64);
                let before_payout = env::storage_usage();
                contract.continue_public_distribution(U64(circle_id));
                distribution_start_bytes += env::storage_usage() as i64 - before_payout as i64;

                let attempt = contract
                    .circles
                    .get(&circle_id)
                    .and_then(|circle| circle.payout_in_flight)
                    .expect("Expected one in-flight public distribution");
                testing_env_with_promise_results(
                    callback_context(),
                    PromiseResult::Successful(Vec::new()),
                );
                let before_callback = env::storage_usage();
                assert!(complete_payout_for_test(&mut contract, circle_id, &attempt));
                payout_callback_bytes += env::storage_usage() as i64 - before_callback as i64;
            }

            assert_eq!(
                contract.get_circle(U64(circle_id)).unwrap().status,
                CircleStatus::Completed
            );
        }

        set_context("creator.testnet", 0, NOW + CYCLES * 2_000);
        assert_eq!(
            contract.get_my_circles(None, Some(50)).len(),
            CYCLES as usize
        );
        let total_net_storage_bytes = registration_bytes
            + start_bytes
            + contribution_bytes
            + round_advance_bytes
            + distribution_start_bytes
            + payout_callback_bytes;
        assert!(total_net_storage_bytes > 0);
        let storage_cost_yocto = u128::try_from(total_net_storage_bytes)
            .expect("Net storage bytes cannot be negative")
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("Ten-cycle storage cost overflow");
        let storage_cost_near_total = storage_cost_yocto as f64 / 1e24_f64;
        let storage_cost_near_per_cycle = storage_cost_near_total / CYCLES as f64;
        println!(
            "AJOCIRCLE_TEN_FULL_CYCLES cycles=10 members_per_cycle=3 rounds_per_cycle=3 registration_net_bytes={} start_net_bytes={} contributions_net_bytes={} round_advances_net_bytes={} distribution_starts_net_bytes={} payout_callbacks_net_bytes={} total_net_storage_bytes={} average_net_bytes_per_cycle={} storage_cost_yocto={} storage_cost_near_total={:.8} storage_cost_near_per_cycle={:.8} storage_byte_price_yocto={}",
            registration_bytes,
            start_bytes,
            contribution_bytes,
            round_advance_bytes,
            distribution_start_bytes,
            payout_callback_bytes,
            total_net_storage_bytes,
            total_net_storage_bytes / CYCLES as i64,
            storage_cost_yocto,
            storage_cost_near_total,
            storage_cost_near_per_cycle,
            env::storage_byte_cost().as_yoctonear()
        );
    }

    #[test]
    fn contract_backing_view_matches_runtime_storage_stake_and_protected_liabilities() {
        let contract = new_contract();
        set_context("keeper.testnet", 0, NOW + 1);

        let view = contract.get_contract_backing_state();
        let expected_storage_stake = u128::from(env::storage_usage())
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap();
        let expected_liquid = env::account_balance()
            .as_yoctonear()
            .saturating_sub(expected_storage_stake);
        let expected_liabilities = contract
            .storage_refund_liability_yocto
            .checked_add(contract.contribution_liability_usdc_base_units)
            .and_then(|value| value.checked_add(contract.penalty_liability_usdc_base_units))
            .and_then(|value| value.checked_add(contract.entry_fee_liability_usdc_base_units))
            .and_then(|value| {
                value.checked_add(contract.distribution_fee_liability_usdc_base_units)
            })
            .unwrap();

        assert_eq!(view.storage_usage_bytes.0, env::storage_usage());
        assert_eq!(
            view.storage_byte_cost_yocto.0,
            env::storage_byte_cost().as_yoctonear()
        );
        assert_eq!(view.storage_stake_yocto.0, expected_storage_stake);
        assert_eq!(
            view.account_balance_yocto.0,
            env::account_balance().as_yoctonear()
        );
        assert_eq!(view.liquid_after_storage_yocto.0, expected_liquid);
        assert_eq!(view.protected_liabilities_yocto.0, expected_liabilities);
        assert_eq!(view.fully_backed, expected_liquid >= expected_liabilities);
    }

    #[test]
    fn registration_deadline_can_close_an_under_capacity_circle() {
        let mut contract = new_contract();
        let id = create_circle(&mut contract, "creator.testnet", CircleMode::Public, 5);
        set_context("anyone.testnet", 0, DEADLINE + 1);
        contract.close_registration(U64(id));
        assert_eq!(
            contract.get_circle(U64(id)).unwrap().status,
            CircleStatus::RegistrationClosed
        );
    }
}