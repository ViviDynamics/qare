export { VERSION } from './version.js'
export {
  PLAN_SCHEMA_VERSION,
  PlanValidationError,
  loadPlan,
  parsePlan,
} from './plan.js'
export type {
  CheckKind,
  Plan,
  PlanCheck,
  PlanCriterion,
  PlannedCriterion,
  UnplannableCriterion,
  CommandCheck,
  FlowCheck,
  VisualCheck,
} from './plan.js'
export { fingerprintPlan, comparePlan, lockPlan } from './plan-lock.js'
export type { PlanComparison } from './plan-lock.js'
export { mintCriterionId, normalizeWording, resolveCriterion } from './criterion-identity.js'
export type { CriterionRevision, CriterionResolution } from './criterion-identity.js'
export {
  RESULT_SCHEMA_VERSION,
  ResultValidationError,
  loadResult,
  parseResult,
} from './result.js'
export { ProfileValidationError, loadProfile, validateProfileConfig } from './profile.js'
export type {
  QaProfile,
  ProfileApp,
  ProfileStub,
  ProfileVisual,
  ProfileSuite,
  ProfileSuiteKind,
} from './profile.js'
export type {
  CriterionOutcome,
  RunVerdict,
  ProvenCriterionResult,
  FailedCriterionResult,
  UnverifiedCriterionResult,
  CriterionResult,
  RunResult,
} from './result.js'
export { FakeAgentRunner, FakeAgentRunnerError, NareAgentRunner, NotImplemented } from './runner.js'
export type {
  AgentBudget,
  AgentRunRequest,
  AgentRunner,
  AgentRunResult,
  AgentRunStatus,
  AgentStopReason,
  AgentUsage,
  ToolPolicy,
} from './runner.js'
export { JobValidationError, loadJobFromFile, loadJobFromText, parseJob } from './job.js'
export type { Job, JobProfileRef, JobCriterion, JobCommandCheck, JobPostTarget } from './job.js'
export { bootApp, stopApp } from './boot.js'
export type { BootOutcome, BootOpts } from './boot.js'
export { runJob } from './run.js'
export { runVisualCheck, type VisualRevision, type VisualCheckOpts, type VisualScreenshot, type VisualDiff, type VisualCheckResult } from './visual.js'
export { runFlowCheck, runSuiteCheck } from './flow.js'
export type { FlowAction, FlowPage, FlowTrace, FlowCheckOpts, FlowCheckResult } from './flow.js'
export {
  makePlaywrightScreenshot,
  disposeBrowser,
  PlaywrightScreenshotBackendError,
} from './visual-playwright.js'
export { makePlaywrightFlowSession, PlaywrightFlowSessionError } from './flow-playwright.js'
export { matchesStub, summarizeEgress, mergeVerdicts } from './egress.js'
export type { EgressAttempt, EgressFinding, EgressStub } from './egress.js'
export { diffStubs, flagAddedStubs } from './stub-diff.js'
export type { StubDiff } from './stub-diff.js'
export {
  consumeVerifierFindings,
  detectRegressions,
  judgeRun,
  prepareVerifierInputs,
  runVerifier,
  toSideResults,
} from './judge.js'
export type {
  CriterionVerdict,
  JudgeRunInput,
  JudgeRunResult,
  Regression,
  SideResult,
  VerifierFinding,
  VerifierInputs,
} from './judge.js'
export { renderComment, renderCheckRun } from './evidence.js'
export type { CheckRunPayload, EvidencePoster } from './evidence.js'
export {
  SetSeenShas,
  decideTrigger,
  handleTrigger,
  makeSeenShas,
  parseTrigger,
} from './triggers.js'
export type { SeenShas, TriggerDecision, TriggerEvent } from './triggers.js'
export { isFork, refuseFork, parseWaiver, recordWaiver } from './waiver.js'
export type { ForkContext, ForkRefusal, ParsedWaiver, WaiverRecord } from './waiver.js'
export {
  BranchLedgerStore,
  FileLedgerStore,
  LEDGER_FILE,
  LEDGER_SCHEMA_VERSION,
  LEDGER_STATUSES,
  parseLedgerEntries,
  serializeLedger,
} from './ledger.js'
export type {
  LedgerEntry,
  LedgerStatus,
  LedgerStore,
  GitRun,
  GitRunResult,
} from './ledger.js'
export {
  LEDGER_PROPOSAL_SCHEMA_VERSION,
  VerificationRecordValidationError,
  buildLedgerProposal,
  parseVerificationRecord,
} from './ledger-proposal.js'
export type {
  VerificationCriterion,
  VerificationOutcome,
  VerificationRecord,
  LedgerProposal,
  LedgerProposalChange,
} from './ledger-proposal.js'
