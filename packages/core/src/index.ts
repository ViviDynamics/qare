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
export { runFlowCheck } from './flow.js'
export type { FlowAction, FlowPage, FlowTrace, FlowCheckOpts, FlowCheckResult } from './flow.js'
export {
  makePlaywrightScreenshot,
  disposeBrowser,
  PlaywrightScreenshotBackendError,
} from './visual-playwright.js'
