//! Deterministic reputation scoring and circle-entry rules.
//! This module is pure logic; it does not claim to persist verified events on-chain.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReputationRecord {
    pub on_time_contributions: u32,
    pub late_contributions: u32,
    pub missed_contributions: u32,
    pub confirmed_defaults: u32,
    pub completed_circles: u32,
}

/// Returns a score from 0 to 1,000. No history is neutral (500).
/// On-time = 1 point, late = 0.5 points, missed/default = 0 points.
/// Contribution outcomes are mutually exclusive; a default must not also be
/// counted as a missed contribution. Completed circles are eligibility data,
/// not extra score points, to prevent circle count from overpowering payment history.
pub fn trust_score(record: ReputationRecord) -> u16 {
    let total = u64::from(record.on_time_contributions)
        + u64::from(record.late_contributions)
        + u64::from(record.missed_contributions)
        + u64::from(record.confirmed_defaults);
    if total == 0 {
        return 500;
    }
    let weighted = u64::from(record.on_time_contributions) * 2
        + u64::from(record.late_contributions);
    ((weighted * 500) / total).min(1_000) as u16
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EligibilityRules {
    pub minimum_score: u16,
    pub minimum_completed_circles: u32,
    pub maximum_confirmed_defaults: u32,
}

impl EligibilityRules {
    pub fn validate(self) -> Result<Self, &'static str> {
        if self.minimum_score > 1_000 {
            return Err("Minimum trust score must be between 0 and 1000");
        }
        Ok(self)
    }

    pub fn allows(self, record: ReputationRecord) -> bool {
        trust_score(record) >= self.minimum_score
            && record.completed_circles >= self.minimum_completed_circles
            && record.confirmed_defaults <= self.maximum_confirmed_defaults
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_history_is_neutral() {
        assert_eq!(trust_score(ReputationRecord::default()), 500);
    }

    #[test]
    fn score_is_deterministic_and_bounded() {
        let record = ReputationRecord {
            on_time_contributions: 8,
            late_contributions: 2,
            missed_contributions: 1,
            confirmed_defaults: 1,
            completed_circles: 2,
        };
        assert_eq!(trust_score(record), 750);
        assert!(trust_score(record) <= 1_000);
    }

    #[test]
    fn perfect_record_scores_one_thousand() {
        assert_eq!(trust_score(ReputationRecord { on_time_contributions: 10, ..Default::default() }), 1_000);
    }

    #[test]
    fn eligibility_checks_all_configured_thresholds() {
        let rules = EligibilityRules {
            minimum_score: 800,
            minimum_completed_circles: 2,
            maximum_confirmed_defaults: 0,
        };
        let good = ReputationRecord {
            on_time_contributions: 9,
            late_contributions: 1,
            completed_circles: 2,
            ..Default::default()
        };
        assert!(rules.allows(good));
        assert!(!rules.allows(ReputationRecord { confirmed_defaults: 1, ..good }));
        assert!(!rules.allows(ReputationRecord { completed_circles: 1, ..good }));
    }

    #[test]
    fn rejects_score_threshold_above_maximum() {
        assert!(EligibilityRules {
            minimum_score: 1_001,
            minimum_completed_circles: 0,
            maximum_confirmed_defaults: 0,
        }.validate().is_err());
    }
}
