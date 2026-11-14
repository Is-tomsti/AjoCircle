//! Test-only ProtectedPublic accounting model.
//!
//! This module is deliberately included only under cfg(test). It validates the
//! proposed reserve/guarantee arithmetic without exposing payable contract
//! entrypoints or changing the deployed Wasm ABI.

use std::collections::BTreeSet;

const BASIS_POINTS: u128 = 10_000;
const DISTRIBUTION_FEE_BPS: u128 = 50;
const PUBLIC_DEFAULT_PENALTY_BPS: u128 = 500;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProtectionError {
    InvalidAmount,
    InvalidAccount,
    DuplicateFunder,
    DuplicateAccount,
    ZeroDenominator,
    ArithmeticOverflow,
    DeadlineNotPassed,
    MissedScanIncomplete,
    DefaultVotesUnresolved,
    InsufficientReserve,
    NoGuarantee,
    WrongGuaranteedMember,
    ReserveStateMismatch,
    WrongGuarantor,
    GuaranteeExpired,
    GuaranteeNotAccepted,
    GuaranteeAlreadyFunded,
    IncorrectCollateralAmount,
    NoVerifiedMiss,
    DuplicateRoundClaim,
    InsufficientGuaranteeCollateral,
    CircleNotSettled,
    PayoutStillPending,
    ReleaseAlreadyPending,
    NoCollateralToRelease,
    InvalidPenaltyBasis,
    DeductionsExceedAvailablePool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DefaultEvidenceGate {
    pub deadline_passed: bool,
    pub missed_scan_complete: bool,
    pub unresolved_default_votes: u32,
}

/// Required protection is exactly the missing scheduled principal, but is
/// unavailable until the immutable deadline and bounded missed scan are final
/// and all default votes for that round are resolved. No grace period is
/// silently assumed here; the accepted circle policy must supply that rule.
pub fn required_protection(
    contribution_per_member_yocto: u128,
    missed_member_count: u32,
    gate: DefaultEvidenceGate,
) -> Result<u128, ProtectionError> {
    if contribution_per_member_yocto == 0 {
        return Err(ProtectionError::InvalidAmount);
    }
    if missed_member_count == 0 {
        return Ok(0);
    }
    if !gate.deadline_passed {
        return Err(ProtectionError::DeadlineNotPassed);
    }
    if !gate.missed_scan_complete {
        return Err(ProtectionError::MissedScanIncomplete);
    }
    if gate.unresolved_default_votes > 0 {
        return Err(ProtectionError::DefaultVotesUnresolved);
    }
    contribution_per_member_yocto
        .checked_mul(u128::from(missed_member_count))
        .ok_or(ProtectionError::ArithmeticOverflow)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReserveUse {
    pub updated_funder_shares: Vec<(String, u128)>,
    pub consumed_by_funder: Vec<(String, u128)>,
    pub updated_guarantee_pool_yocto: u128,
    pub guarantee_pool_consumed_yocto: u128,
}

/// Consumes direct reserve funder shares in stable FIFO order first, then
/// claimed guarantee collateral. The input is immutable, so insufficient
/// coverage cannot leave partially changed balances.
pub fn prepare_reserve_use(
    funder_shares: &[(String, u128)],
    guarantee_pool_yocto: u128,
    required_yocto: u128,
) -> Result<ReserveUse, ProtectionError> {
    if required_yocto == 0 {
        return Err(ProtectionError::InvalidAmount);
    }

    let mut seen = BTreeSet::new();
    let mut available_direct = 0u128;
    for (account, amount) in funder_shares {
        if account.trim().is_empty() {
            return Err(ProtectionError::InvalidAccount);
        }
        if !seen.insert(account.as_str()) {
            return Err(ProtectionError::DuplicateFunder);
        }
        available_direct = available_direct
            .checked_add(*amount)
            .ok_or(ProtectionError::ArithmeticOverflow)?;
    }
    let total_available = available_direct
        .checked_add(guarantee_pool_yocto)
        .ok_or(ProtectionError::ArithmeticOverflow)?;
    if total_available < required_yocto {
        return Err(ProtectionError::InsufficientReserve);
    }

    let mut remaining = required_yocto;
    let mut updated = Vec::with_capacity(funder_shares.len());
    let mut consumed = Vec::new();

    for (account, share) in funder_shares {
        let used = (*share).min(remaining);
        let new_share = share
            .checked_sub(used)
            .ok_or(ProtectionError::ArithmeticOverflow)?;
        updated.push((account.clone(), new_share));
        if used > 0 {
            consumed.push((account.clone(), used));
        }
        remaining -= used;
    }

    let guarantee_used = remaining.min(guarantee_pool_yocto);
    remaining -= guarantee_used;
    if remaining != 0 {
        return Err(ProtectionError::InsufficientReserve);
    }

    Ok(ReserveUse {
        updated_funder_shares: updated,
        consumed_by_funder: consumed,
        updated_guarantee_pool_yocto: guarantee_pool_yocto - guarantee_used,
        guarantee_pool_consumed_yocto: guarantee_used,
    })
}

/// Rolls back an unfinalized reserve use after a failed all-or-nothing payout.
/// For central multi-recipient distribution, successful per-member transfers
/// require per-member source allocations and must not use this coarse rollback.
pub fn rollback_reserve_use(
    current_funder_shares: &[(String, u128)],
    current_guarantee_pool_yocto: u128,
    use_record: &ReserveUse,
) -> Result<(Vec<(String, u128)>, u128), ProtectionError> {
    if current_funder_shares != use_record.updated_funder_shares
        || current_guarantee_pool_yocto != use_record.updated_guarantee_pool_yocto
    {
        return Err(ProtectionError::ReserveStateMismatch);
    }

    if current_funder_shares != use_record.updated_funder_shares
        || current_guarantee_pool_yocto != use_record.updated_guarantee_pool_yocto
    {
        return Err(ProtectionError::ReserveStateMismatch);
    }

    let mut restored = current_funder_shares.to_vec();
    let mut positions = std::collections::BTreeMap::new();
    for (index, (account, _)) in restored.iter().enumerate() {
        if positions.insert(account.clone(), index).is_some() {
            return Err(ProtectionError::DuplicateFunder);
        }
    }

    for (account, amount) in &use_record.consumed_by_funder {
        let index = *positions
            .get(account)
            .ok_or(ProtectionError::InvalidAccount)?;
        restored[index].1 = restored[index]
            .1
            .checked_add(*amount)
            .ok_or(ProtectionError::ArithmeticOverflow)?;
    }

    let restored_guarantee_pool = current_guarantee_pool_yocto
        .checked_add(use_record.guarantee_pool_consumed_yocto)
        .ok_or(ProtectionError::ArithmeticOverflow)?;
    Ok((restored, restored_guarantee_pool))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WeightedMember {
    pub account_id: String,
    pub verified_contribution_yocto: u128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReserveBonus {
    pub account_id: String,
    pub amount_yocto: u128,
}

/// Computes exact reserve-pool allocation using largest remainder. The
/// reserve bonus follows existing verified contribution weights; it never
/// fabricates contribution principal or increases a member's contribution
/// weight. Remainder ties are resolved by ascending account ID.
pub fn allocate_reserve_bonus(
    reserve_pool_yocto: u128,
    members: &[WeightedMember],
) -> Result<Vec<ReserveBonus>, ProtectionError> {
    if members.is_empty() {
        return Err(ProtectionError::InvalidAmount);
    }

    let mut seen = BTreeSet::new();
    let mut total_weight = 0u128;
    for member in members {
        if member.account_id.trim().is_empty() {
            return Err(ProtectionError::InvalidAccount);
        }
        if !seen.insert(member.account_id.as_str()) {
            return Err(ProtectionError::DuplicateAccount);
        }
        total_weight = total_weight
            .checked_add(member.verified_contribution_yocto)
            .ok_or(ProtectionError::ArithmeticOverflow)?;
    }
    if total_weight == 0 {
        return Err(ProtectionError::ZeroDenominator);
    }

    let mut allocations = Vec::with_capacity(members.len());
    let mut remainders = Vec::with_capacity(members.len());
    let mut allocated_total = 0u128;

    for (index, member) in members.iter().enumerate() {
        let (base, remainder) = mul_div_rem(
            reserve_pool_yocto,
            member.verified_contribution_yocto,
            total_weight,
        )?;
        allocated_total = allocated_total
            .checked_add(base)
            .ok_or(ProtectionError::ArithmeticOverflow)?;
        allocations.push(base);
        remainders.push((index, remainder, member.account_id.as_str()));
    }

    let remainder_units = reserve_pool_yocto
        .checked_sub(allocated_total)
        .ok_or(ProtectionError::ArithmeticOverflow)?;
    let remainder_units =
        usize::try_from(remainder_units).map_err(|_| ProtectionError::ArithmeticOverflow)?;
    if remainder_units > members.len() {
        return Err(ProtectionError::ArithmeticOverflow);
    }

    remainders.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.2.cmp(right.2)));
    for (index, _, _) in remainders.into_iter().take(remainder_units) {
        allocations[index] = allocations[index]
            .checked_add(1)
            .ok_or(ProtectionError::ArithmeticOverflow)?;
    }

    Ok(members
        .iter()
        .zip(allocations)
        .map(|(member, amount_yocto)| ReserveBonus {
            account_id: member.account_id.clone(),
            amount_yocto,
        })
        .collect())
}

/// Returns floor(a*b/d) and (a*b) mod d without overflowing an intermediate
/// u128 product. The reserve allocator always supplies 0 <= b <= d.
fn mul_div_rem(a: u128, b: u128, d: u128) -> Result<(u128, u128), ProtectionError> {
    if d == 0 {
        return Err(ProtectionError::ZeroDenominator);
    }
    if b > d {
        return Err(ProtectionError::InvalidAmount);
    }
    if b == 0 || a == 0 {
        return Ok((0, 0));
    }
    if b == d {
        return Ok((a, 0));
    }

    let mut quotient = 0u128;
    let mut remainder = 0u128;

    for bit in (0..128).rev() {
        let mut carry = 0u128;

        // Double remainder modulo d without forming 2*remainder when that
        // intermediate could overflow u128.
        if remainder >= d - remainder {
            remainder -= d - remainder;
            carry += 1;
        } else {
            remainder += remainder;
        }

        if ((a >> bit) & 1) == 1 {
            // Add b modulo d without forming remainder+b when it could
            // overflow u128. Since b < d in this branch, carry is at most 2.
            if remainder >= d - b {
                remainder -= d - b;
                carry += 1;
            } else {
                remainder += b;
            }
        }

        quotient = quotient
            .checked_mul(2)
            .and_then(|value| value.checked_add(carry))
            .ok_or(ProtectionError::ArithmeticOverflow)?;
    }

    Ok((quotient, remainder))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemberSettlement {
    pub contribution_principal_yocto: u128,
    pub reserve_bonus_yocto: u128,
    pub penalty_basis_yocto: u128,
    pub penalty_yocto: u128,
    pub distribution_fee_yocto: u128,
    pub transfer_yocto: u128,
}

/// Proposed central distribution treatment:
/// - reserve bonus is paid separately and does not alter contribution weights;
/// - the 0.5% distribution fee is calculated on verified contribution principal;
/// - the 5% penalty is applied only after removal approval and review clearance,
///   and only to the supplied eligible-refund basis (never to reserve bonus).
pub fn calculate_member_settlement(
    contribution_principal_yocto: u128,
    reserve_bonus_yocto: u128,
    eligible_refund_penalty_basis_yocto: u128,
    removal_approved: bool,
    review_cleared: bool,
) -> Result<MemberSettlement, ProtectionError> {
    if eligible_refund_penalty_basis_yocto > contribution_principal_yocto {
        return Err(ProtectionError::InvalidPenaltyBasis);
    }

    let penalty_basis = if removal_approved && review_cleared {
        eligible_refund_penalty_basis_yocto
    } else {
        0
    };
    let penalty = basis_point_amount(penalty_basis, PUBLIC_DEFAULT_PENALTY_BPS)?;
    let distribution_fee = basis_point_amount(contribution_principal_yocto, DISTRIBUTION_FEE_BPS)?;

    let transfer = contribution_principal_yocto
        .checked_add(reserve_bonus_yocto)
        .ok_or(ProtectionError::ArithmeticOverflow)?
        .checked_sub(penalty)
        .and_then(|value| value.checked_sub(distribution_fee))
        .ok_or(ProtectionError::DeductionsExceedAvailablePool)?;

    Ok(MemberSettlement {
        contribution_principal_yocto,
        reserve_bonus_yocto,
        penalty_basis_yocto: penalty_basis,
        penalty_yocto: penalty,
        distribution_fee_yocto: distribution_fee,
        transfer_yocto: transfer,
    })
}

fn basis_point_amount(amount: u128, basis_points: u128) -> Result<u128, ProtectionError> {
    let (value, _) = mul_div_rem(amount, basis_points, BASIS_POINTS)?;
    Ok(value)
}

pub fn full_cycle_guarantee_requirement(
    contribution_per_round_yocto: u128,
    scheduled_rounds: u32,
) -> Result<u128, ProtectionError> {
    if contribution_per_round_yocto == 0 || scheduled_rounds == 0 {
        return Err(ProtectionError::InvalidAmount);
    }
    contribution_per_round_yocto
        .checked_mul(u128::from(scheduled_rounds))
        .ok_or(ProtectionError::ArithmeticOverflow)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MissedRoundEvidence {
    pub round_index: u32,
    pub contribution_per_round_yocto: u128,
    pub deadline_ns: u64,
    pub now_ns: u64,
    pub verified_missed_record_exists: bool,
    pub missed_scan_complete: bool,
    pub unresolved_default_votes: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuaranteeLedger {
    member_id: String,
    guarantor_id: String,
    required_yocto: u128,
    locked_yocto: u128,
    expiry_ns: u64,
    accepted: bool,
    active: bool,
    claimed_rounds: BTreeSet<u32>,
    pending_release_yocto: Option<u128>,
}

impl GuaranteeLedger {
    pub fn request(
        member_id: String,
        guarantor_id: String,
        required_yocto: u128,
        expiry_ns: u64,
        now_ns: u64,
        final_scheduled_deadline_ns: u64,
    ) -> Result<Self, ProtectionError> {
        if member_id.trim().is_empty()
            || guarantor_id.trim().is_empty()
            || member_id == guarantor_id
        {
            return Err(ProtectionError::InvalidAccount);
        }
        if required_yocto == 0 {
            return Err(ProtectionError::InvalidAmount);
        }
        if expiry_ns <= now_ns || expiry_ns <= final_scheduled_deadline_ns {
            return Err(ProtectionError::GuaranteeExpired);
        }
        Ok(Self {
            member_id,
            guarantor_id,
            required_yocto,
            locked_yocto: 0,
            expiry_ns,
            accepted: false,
            active: false,
            claimed_rounds: BTreeSet::new(),
            pending_release_yocto: None,
        })
    }

    pub fn accept(&mut self, caller: &str, now_ns: u64) -> Result<(), ProtectionError> {
        if caller != self.guarantor_id {
            return Err(ProtectionError::WrongGuarantor);
        }
        if now_ns >= self.expiry_ns {
            return Err(ProtectionError::GuaranteeExpired);
        }
        if self.accepted || self.active {
            return Err(ProtectionError::GuaranteeNotAccepted);
        }
        self.accepted = true;
        Ok(())
    }

    pub fn fund(
        &mut self,
        caller: &str,
        attached_yocto: u128,
        now_ns: u64,
    ) -> Result<(), ProtectionError> {
        if caller != self.guarantor_id {
            return Err(ProtectionError::WrongGuarantor);
        }
        if !self.accepted {
            return Err(ProtectionError::GuaranteeNotAccepted);
        }
        if now_ns >= self.expiry_ns {
            return Err(ProtectionError::GuaranteeExpired);
        }
        if self.active || self.locked_yocto > 0 {
            return Err(ProtectionError::GuaranteeAlreadyFunded);
        }
        if attached_yocto != self.required_yocto {
            return Err(ProtectionError::IncorrectCollateralAmount);
        }
        self.locked_yocto = attached_yocto;
        self.active = true;
        Ok(())
    }

    /// A claim is valid only for an on-chain missed record after its deadline
    /// and after the full bounded scan has completed. Caller authorization is
    /// intentionally permissionless; all evidence predicates are mandatory.
    pub fn claim_missed_round(
        &mut self,
        missed_member_id: &str,
        evidence: MissedRoundEvidence,
    ) -> Result<u128, ProtectionError> {
        if missed_member_id != self.member_id {
            return Err(ProtectionError::WrongGuaranteedMember);
        }
        if !self.active {
            return Err(ProtectionError::NoGuarantee);
        }
        if evidence.now_ns >= self.expiry_ns {
            return Err(ProtectionError::GuaranteeExpired);
        }
        if evidence.now_ns < evidence.deadline_ns {
            return Err(ProtectionError::DeadlineNotPassed);
        }
        if !evidence.missed_scan_complete {
            return Err(ProtectionError::MissedScanIncomplete);
        }
        if evidence.unresolved_default_votes > 0 {
            return Err(ProtectionError::DefaultVotesUnresolved);
        }
        if !evidence.verified_missed_record_exists {
            return Err(ProtectionError::NoVerifiedMiss);
        }
        if self.claimed_rounds.contains(&evidence.round_index) {
            return Err(ProtectionError::DuplicateRoundClaim);
        }
        if evidence.contribution_per_round_yocto == 0
            || self.locked_yocto < evidence.contribution_per_round_yocto
        {
            return Err(ProtectionError::InsufficientGuaranteeCollateral);
        }
        self.locked_yocto -= evidence.contribution_per_round_yocto;
        self.claimed_rounds.insert(evidence.round_index);
        Ok(evidence.contribution_per_round_yocto)
    }

    pub fn begin_release(
        &mut self,
        circle_settled: bool,
        all_distribution_transfers_final: bool,
        payout_pending: bool,
    ) -> Result<u128, ProtectionError> {
        if !circle_settled || !all_distribution_transfers_final {
            return Err(ProtectionError::CircleNotSettled);
        }
        if payout_pending {
            return Err(ProtectionError::PayoutStillPending);
        }
        if self.pending_release_yocto.is_some() {
            return Err(ProtectionError::ReleaseAlreadyPending);
        }
        if !self.active || self.locked_yocto == 0 {
            return Err(ProtectionError::NoCollateralToRelease);
        }
        let amount = self.locked_yocto;
        self.locked_yocto = 0;
        self.active = false;
        self.pending_release_yocto = Some(amount);
        Ok(amount)
    }

    /// On failure the exact collateral and active guarantee are restored. A
    /// successful callback clears the pending release permanently.
    pub fn finish_release(&mut self, succeeded: bool) -> Result<u128, ProtectionError> {
        let amount = self
            .pending_release_yocto
            .take()
            .ok_or(ProtectionError::ReleaseAlreadyPending)?;
        if !succeeded {
            self.locked_yocto = self
                .locked_yocto
                .checked_add(amount)
                .ok_or(ProtectionError::ArithmeticOverflow)?;
            self.active = true;
        }
        Ok(amount)
    }

    pub fn locked_yocto(&self) -> u128 {
        self.locked_yocto
    }

    pub fn active(&self) -> bool {
        self.active
    }

    pub fn has_claimed_round(&self, round_index: u32) -> bool {
        self.claimed_rounds.contains(&round_index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate_ok() -> DefaultEvidenceGate {
        DefaultEvidenceGate {
            deadline_passed: true,
            missed_scan_complete: true,
            unresolved_default_votes: 0,
        }
    }

    #[test]
    fn circle_entry_fee_is_fixed_at_025_usdc_with_six_decimals() {
        assert_eq!(super::super::USDC_ENTRY_FEE_BASE_UNITS, 250_000);
        // AjoCircle collects this separately as NEP-141 USDC, never as NEAR gas/storage.
    }

    #[test]
    fn reserve_requirement_fails_closed_until_default_evidence_is_final() {
        let mut gate = gate_ok();
        gate.deadline_passed = false;
        assert_eq!(
            required_protection(100, 2, gate),
            Err(ProtectionError::DeadlineNotPassed)
        );

        gate = gate_ok();
        gate.missed_scan_complete = false;
        assert_eq!(
            required_protection(100, 2, gate),
            Err(ProtectionError::MissedScanIncomplete)
        );

        gate = gate_ok();
        gate.unresolved_default_votes = 1;
        assert_eq!(
            required_protection(100, 2, gate),
            Err(ProtectionError::DefaultVotesUnresolved)
        );

        assert_eq!(required_protection(100, 2, gate_ok()), Ok(200));
    }

    #[test]
    fn reserve_requirement_uses_only_the_actual_missed_principal() {
        assert_eq!(required_protection(75, 0, gate_ok()), Ok(0));
        assert_eq!(required_protection(75, 1, gate_ok()), Ok(75));
        assert_eq!(required_protection(75, 3, gate_ok()), Ok(225));
        assert_eq!(
            required_protection(u128::MAX, 2, gate_ok()),
            Err(ProtectionError::ArithmeticOverflow)
        );
    }

    #[test]
    fn reserve_use_is_fifo_exact_and_failed_payout_can_restore_sources() {
        let shares = vec![
            ("alice.near".to_string(), 100),
            ("bob.near".to_string(), 80),
        ];
        let use_record = prepare_reserve_use(&shares, 50, 170).unwrap();
        assert_eq!(
            use_record.updated_funder_shares,
            vec![("alice.near".to_string(), 0), ("bob.near".to_string(), 10),]
        );
        assert_eq!(
            use_record.consumed_by_funder,
            vec![
                ("alice.near".to_string(), 100),
                ("bob.near".to_string(), 70),
            ]
        );
        assert_eq!(use_record.updated_guarantee_pool_yocto, 50);
        assert_eq!(use_record.guarantee_pool_consumed_yocto, 0);

        let restored = rollback_reserve_use(
            &use_record.updated_funder_shares,
            use_record.updated_guarantee_pool_yocto,
            &use_record,
        )
        .unwrap();
        assert_eq!(restored.0, shares);
        assert_eq!(restored.1, 50);
        assert_eq!(
            rollback_reserve_use(&restored.0, restored.1, &use_record),
            Err(ProtectionError::ReserveStateMismatch)
        );
    }

    #[test]
    fn reserve_use_uses_guarantee_pool_only_after_direct_funder_shares() {
        let shares = vec![("sponsor.near".to_string(), 25)];
        let use_record = prepare_reserve_use(&shares, 100, 90).unwrap();
        assert_eq!(use_record.updated_funder_shares[0].1, 0);
        assert_eq!(use_record.consumed_by_funder[0].1, 25);
        assert_eq!(use_record.updated_guarantee_pool_yocto, 35);
        assert_eq!(use_record.guarantee_pool_consumed_yocto, 65);
    }

    #[test]
    fn insufficient_reserve_is_atomic_and_duplicate_funders_are_rejected() {
        let shares = vec![("alice.near".to_string(), 10)];
        assert_eq!(
            prepare_reserve_use(&shares, 5, 16),
            Err(ProtectionError::InsufficientReserve)
        );
        let duplicates = vec![
            ("alice.near".to_string(), 10),
            ("alice.near".to_string(), 20),
        ];
        assert_eq!(
            prepare_reserve_use(&duplicates, 0, 1),
            Err(ProtectionError::DuplicateFunder)
        );
        // The original vector remains unchanged because the planner is pure.
        assert_eq!(shares, vec![("alice.near".to_string(), 10)]);
    }

    #[test]
    fn reserve_bonus_uses_verified_contribution_weights_and_conserves_every_unit() {
        let members = vec![
            WeightedMember {
                account_id: "alice.near".to_string(),
                verified_contribution_yocto: 100,
            },
            WeightedMember {
                account_id: "bob.near".to_string(),
                verified_contribution_yocto: 200,
            },
            WeightedMember {
                account_id: "carol.near".to_string(),
                verified_contribution_yocto: 300,
            },
        ];
        let allocations = allocate_reserve_bonus(101, &members).unwrap();
        assert_eq!(
            allocations.iter().map(|x| x.amount_yocto).sum::<u128>(),
            101
        );
        assert_eq!(
            allocations
                .iter()
                .map(|x| x.amount_yocto)
                .collect::<Vec<_>>(),
            vec![17, 34, 50]
        );
    }

    #[test]
    fn reserve_bonus_remainder_ties_break_by_ascending_account_id() {
        let members = vec![
            WeightedMember {
                account_id: "bob.near".to_string(),
                verified_contribution_yocto: 1,
            },
            WeightedMember {
                account_id: "alice.near".to_string(),
                verified_contribution_yocto: 1,
            },
            WeightedMember {
                account_id: "carol.near".to_string(),
                verified_contribution_yocto: 1,
            },
        ];
        let allocations = allocate_reserve_bonus(2, &members).unwrap();
        assert_eq!(
            allocations
                .iter()
                .map(|x| x.amount_yocto)
                .collect::<Vec<_>>(),
            vec![1, 1, 0]
        );
    }

    #[test]
    fn reserve_bonus_supports_near_scale_u128_values_without_product_overflow() {
        let members = vec![
            WeightedMember {
                account_id: "alice.near".to_string(),
                verified_contribution_yocto: u128::MAX / 2,
            },
            WeightedMember {
                account_id: "bob.near".to_string(),
                verified_contribution_yocto: u128::MAX / 2,
            },
        ];
        let allocations = allocate_reserve_bonus(u128::MAX, &members).unwrap();
        assert_eq!(allocations[0].amount_yocto, u128::MAX / 2 + 1);
        assert_eq!(allocations[1].amount_yocto, u128::MAX / 2);
        assert_eq!(
            allocations.iter().map(|x| x.amount_yocto).sum::<u128>(),
            u128::MAX
        );
    }

    #[test]
    fn reserve_bonus_rejects_duplicate_accounts_and_zero_total_weight() {
        let duplicate = vec![
            WeightedMember {
                account_id: "alice.near".to_string(),
                verified_contribution_yocto: 1,
            },
            WeightedMember {
                account_id: "alice.near".to_string(),
                verified_contribution_yocto: 2,
            },
        ];
        assert_eq!(
            allocate_reserve_bonus(1, &duplicate),
            Err(ProtectionError::DuplicateAccount)
        );
        let zero = vec![WeightedMember {
            account_id: "alice.near".to_string(),
            verified_contribution_yocto: 0,
        }];
        assert_eq!(
            allocate_reserve_bonus(1, &zero),
            Err(ProtectionError::ZeroDenominator)
        );
    }

    #[test]
    fn reserve_bonus_is_not_added_to_weight_or_penalty_basis() {
        let members = vec![
            WeightedMember {
                account_id: "alice.near".to_string(),
                verified_contribution_yocto: 100,
            },
            WeightedMember {
                account_id: "bob.near".to_string(),
                verified_contribution_yocto: 300,
            },
        ];
        let allocations = allocate_reserve_bonus(40, &members).unwrap();
        assert_eq!(
            allocations
                .iter()
                .map(|x| x.amount_yocto)
                .collect::<Vec<_>>(),
            vec![10, 30]
        );
        let alice = calculate_member_settlement(100, 10, 0, false, false).unwrap();
        assert_eq!(alice.distribution_fee_yocto, 0); // floor(100 * 50 / 10,000)
        assert_eq!(alice.penalty_yocto, 0);
        assert_eq!(alice.transfer_yocto, 110);
    }

    #[test]
    fn five_percent_penalty_requires_approved_removal_and_cleared_review() {
        let pending = calculate_member_settlement(10_000, 0, 8_000, false, false).unwrap();
        assert_eq!(pending.penalty_yocto, 0);

        let review_open = calculate_member_settlement(10_000, 0, 8_000, true, false).unwrap();
        assert_eq!(review_open.penalty_yocto, 0);

        let cleared = calculate_member_settlement(10_000, 0, 8_000, true, true).unwrap();
        assert_eq!(cleared.penalty_yocto, 400);
        assert_eq!(cleared.transfer_yocto, 9_550);
    }

    #[test]
    fn full_cycle_guarantee_is_exact_and_overflow_checked() {
        assert_eq!(full_cycle_guarantee_requirement(25, 5), Ok(125));
        assert_eq!(
            full_cycle_guarantee_requirement(u128::MAX, 2),
            Err(ProtectionError::ArithmeticOverflow)
        );
        assert_eq!(
            full_cycle_guarantee_requirement(25, 0),
            Err(ProtectionError::InvalidAmount)
        );
    }

    fn funded_guarantee() -> GuaranteeLedger {
        let mut guarantee = GuaranteeLedger::request(
            "member.near".to_string(),
            "guarantor.near".to_string(),
            500,
            10_000,
            100,
            9_000,
        )
        .unwrap();
        guarantee.accept("guarantor.near", 101).unwrap();
        guarantee.fund("guarantor.near", 500, 102).unwrap();
        guarantee
    }

    fn missed_evidence(
        round_index: u32,
        now_ns: u64,
        verified: bool,
        scan_complete: bool,
        unresolved_votes: u32,
    ) -> MissedRoundEvidence {
        MissedRoundEvidence {
            round_index,
            contribution_per_round_yocto: 100,
            deadline_ns: 200,
            now_ns,
            verified_missed_record_exists: verified,
            missed_scan_complete: scan_complete,
            unresolved_default_votes: unresolved_votes,
        }
    }

    #[test]
    fn guarantee_requires_nominated_acceptance_exact_funding_and_verified_miss() {
        let mut guarantee = GuaranteeLedger::request(
            "member.near".to_string(),
            "guarantor.near".to_string(),
            500,
            10_000,
            100,
            9_000,
        )
        .unwrap();
        assert_eq!(
            guarantee.fund("guarantor.near", 500, 101),
            Err(ProtectionError::GuaranteeNotAccepted)
        );
        guarantee.accept("guarantor.near", 102).unwrap();
        assert_eq!(
            guarantee.fund("stranger.near", 500, 103),
            Err(ProtectionError::WrongGuarantor)
        );
        assert_eq!(
            guarantee.fund("guarantor.near", 499, 103),
            Err(ProtectionError::IncorrectCollateralAmount)
        );
        guarantee.fund("guarantor.near", 500, 104).unwrap();
        assert_eq!(
            guarantee.claim_missed_round("member.near", missed_evidence(0, 201, false, true, 0)),
            Err(ProtectionError::NoVerifiedMiss)
        );
        assert_eq!(
            guarantee.claim_missed_round("other.near", missed_evidence(0, 201, true, true, 0)),
            Err(ProtectionError::WrongGuaranteedMember)
        );
        assert_eq!(
            guarantee.claim_missed_round("member.near", missed_evidence(0, 201, true, true, 1)),
            Err(ProtectionError::DefaultVotesUnresolved)
        );
        assert_eq!(
            guarantee.claim_missed_round("member.near", missed_evidence(0, 201, true, false, 0)),
            Err(ProtectionError::MissedScanIncomplete)
        );
        assert_eq!(guarantee.locked_yocto(), 500);
    }

    #[test]
    fn guarantee_claim_is_deadline_bound_and_once_per_round() {
        let mut guarantee = funded_guarantee();
        assert_eq!(
            guarantee.claim_missed_round("member.near", missed_evidence(0, 199, true, true, 0)),
            Err(ProtectionError::DeadlineNotPassed)
        );
        assert_eq!(
            guarantee.claim_missed_round("member.near", missed_evidence(0, 201, true, true, 0)),
            Ok(100)
        );
        assert_eq!(guarantee.locked_yocto(), 400);
        assert!(guarantee.has_claimed_round(0));
        assert_eq!(
            guarantee.claim_missed_round("member.near", missed_evidence(0, 202, true, true, 0)),
            Err(ProtectionError::DuplicateRoundClaim)
        );
        assert_eq!(
            guarantee.claim_missed_round("member.near", missed_evidence(1, 203, true, true, 0)),
            Ok(100)
        );
        assert_eq!(guarantee.locked_yocto(), 300);
    }

    #[test]
    fn unused_guarantee_collateral_releases_only_after_all_payouts_and_restores_on_failure() {
        let mut guarantee = funded_guarantee();
        guarantee
            .claim_missed_round("member.near", missed_evidence(0, 201, true, true, 0))
            .unwrap();
        assert_eq!(
            guarantee.begin_release(false, false, false),
            Err(ProtectionError::CircleNotSettled)
        );
        assert_eq!(
            guarantee.begin_release(true, true, true),
            Err(ProtectionError::PayoutStillPending)
        );

        assert_eq!(guarantee.begin_release(true, true, false), Ok(400));
        assert_eq!(guarantee.locked_yocto(), 0);
        assert!(!guarantee.active());
        assert_eq!(guarantee.finish_release(false), Ok(400));
        assert_eq!(guarantee.locked_yocto(), 400);
        assert!(guarantee.active());

        assert_eq!(guarantee.begin_release(true, true, false), Ok(400));
        assert_eq!(guarantee.finish_release(true), Ok(400));
        assert_eq!(guarantee.locked_yocto(), 0);
        assert!(!guarantee.active());
    }

    #[test]
    fn fee_and_penalty_are_separate_from_entry_fee_and_reserve_principal() {
        let settlement =
            calculate_member_settlement(1_000_000, 100_000, 200_000, true, true).unwrap();
        assert_eq!(settlement.penalty_yocto, 10_000);
        assert_eq!(settlement.distribution_fee_yocto, 5_000);