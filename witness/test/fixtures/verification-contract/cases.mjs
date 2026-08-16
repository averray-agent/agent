export const RULE_DRILLS = Object.freeze([
  {
    number: 1,
    file: "rule-1-materialization-status.json",
    code: "VCV1_RULE_1_MATERIALIZATION_STATUS",
    correct(contract) {
      contract.subject.materialization.status = "HERMETIC";
    }
  },
  {
    number: 2,
    file: "rule-2-mocked-inputs.json",
    code: "VCV1_RULE_2_MOCKED_EXTERNAL_INPUTS",
    correct(contract) {
      contract.subject.materialization.frozen_inputs = [{ path: "fixtures/api.json", sha256: "frozen-input" }];
    }
  },
  {
    number: 3,
    file: "rule-3-required-targeted.json",
    code: "VCV1_RULE_3_REQUIRED_TARGETED_CHECK",
    correct(contract) {
      contract.checks.targeted[0].required = true;
    }
  },
  {
    number: 4,
    file: "rule-4-targeted-base-pass.json",
    code: "VCV1_RULE_4_TARGETED_BASE_MUST_FAIL",
    correct(contract) {
      contract.checks.targeted[0].expected_on_base = "fail";
    }
  },
  {
    number: 5,
    file: "rule-5-command-protection.json",
    code: "VCV1_RULE_5_JUDGING_COMMAND_PROTECTED",
    correct(contract) {
      contract.candidate.protected_paths = ["package.json"];
    }
  },
  {
    number: 6,
    file: "rule-6-base-red-regression.json",
    code: "VCV1_RULE_6_REQUIRED_REGRESSION_BASE_RED",
    correct(contract) {
      contract.checks.regression[0].base_state = "green";
    }
  },
  {
    number: 7,
    file: "rule-7-hidden-eligibility.json",
    code: "VCV1_RULE_7_REQUIRED_HIDDEN_ELIGIBILITY",
    correct(contract) {
      contract.checks.hidden.eligibility_reference_sha256 = "known-good-reference";
    }
  },
  {
    number: 8,
    file: "rule-8-assurance-floor.json",
    code: "VCV1_RULE_8_SETTLEMENT_ASSURANCE_FLOOR",
    correct(contract) {
      contract.settlement.minimum_assurance_level = "AV-2";
    }
  }
]);
