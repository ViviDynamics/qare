export { VERSION } from './version.js'
export {
  PLAN_SCHEMA_VERSION,
  PlanValidationError,
  loadPlan,
  parsePlan,
  parseFlowActions,
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
  FlowActionStep,
} from './plan.js'
export { fingerprintPlan, comparePlan, lockPlan } from './plan-lock.js'
export type { PlanComparison } from './plan-lock.js'
export { mintRunValues, substituteValues, validateValueReferences } from './values.js'
export type { RunValues } from './values.js'
export { mintCriterionId, normalizeWording, resolveCriterion } from './criterion-identity.js'
export type { CriterionRevision, CriterionResolution } from './criterion-identity.js'
export {
  RESULT_SCHEMA_VERSION,
  ResultValidationError,
  loadResult,
  parseResult,
} from './result.js'
export { ProfileMissingError, ProfileValidationError, loadProfile, pathOnTarget, validateProfileConfig } from './profile.js'
export {
  BUILTIN_REDACTION_RULES,
  REDACTED,
  RedactionError,
  redactEvidenceDir,
  redactResult,
  redactText,
  redactValue,
  redactionRules,
  valueRules,
  validateMaskSelectors,
} from './redact.js'
export type { EvidenceRedaction, ProfileRedaction, RedactionRule } from './redact.js'
export type {
  QaProfile,
  ProfileApp,
  ProfileTarget,
  ProfileStub,
  ProfileVisual,
  ProfileSuite,
  ProfileSuiteKind,
  ProfileMcpServer,
  ProfileMcpToolMap,
  McpStep,
} from './profile.js'
export { MCP_DRIVER_INTENTS } from './profile.js'
export {
  DEFAULT_PROFILE_NAME,
  discoverProfiles,
  pathUnderArea,
  profileCovers,
  selectProfiles,
  touchedPathsFromDiff,
} from './monorepo.js'
export type { NamedProfile } from './monorepo.js'
export type {
  CriterionOutcome,
  RunVerdict,
  ProvenCriterionResult,
  FailedCriterionResult,
  UnverifiedCriterionResult,
  CriterionResult,
  RunResult,
  RunTarget,
} from './result.js'
export {
  FakeAgentRunner,
  FakeAgentRunnerError,
  NARE_CONTRACT,
  NareAgentRunner,
  NareRunnerError,
  NotImplemented,
} from './runner.js'
export type {
  AgentBudget,
  AgentRunRequest,
  AgentRunner,
  AgentRunResult,
  AgentRunStatus,
  AgentStopReason,
  AgentToolChannel,
  AgentUsage,
  NareAgentRunnerOptions,
  ToolPolicy,
} from './runner.js'
export {
  EXPLORATION_TOOLS,
  callExplorationTool,
  needsSandboxSplit,
  sandboxEnvironment,
  startExplorationServer,
  untrustedToolResult,
  ExplorationError,
} from './explore.js'
export type { ExplorationPage, ExplorationSource, ExplorationTool } from './explore.js'
export {
  McpError,
  McpUnreachable,
  callChannelTool,
  channelToolName,
  connectMcpDriver,
  connectMcpServer,
  mcpDriverCapabilities,
  mcpDriverServer,
  mcpRecordsFile,
  splitMcpCommand,
  startMcpToolServer,
  startRegisteredMcpSources,
} from './mcp.js'
export type {
  McpCallRecord,
  McpDriverCall,
  McpDriverSession,
  McpRecorder,
  McpSource,
  McpTool,
  McpToolResult,
  McpToolServer,
  ConnectOptions,
} from './mcp.js'
export { IssueCriteriaError, criteriaFromIssue, criteriaFromIssues, criterionIdFor } from './issue-criteria.js'
export type { IssueCriteriaProblem } from './issue-criteria.js'
export { linkedIssues } from './linked-issues.js'
export { jobFromPlan } from './job-from-plan.js'
export type { RunContext } from './job-from-plan.js'
export { NO_DIFF, PLAN_OUTPUT_SCHEMA, PlanStepError, planRun } from './plan-step.js'
export type { DeclaredRunInputs, PlanCriterionInput, PlanInputs } from './plan-step.js'
export { JobValidationError, loadJobFromFile, loadJobFromText, parseJob } from './job.js'
export type { Job, JobProfileRef, JobCriterion, JobCommandCheck, JobFlowCheck, JobCheck, JobPostTarget, JobProfileGroup, SingleProfileJob, SeveralProfilesJob } from './job.js'
export { httpMailbox, mailEvidence, runMailCheck, extractCode, DEFAULT_CODE_PATTERN } from './mailbox.js'
export type { MailMessage, MailEvidenceMessage, MailOutcome, ReadMail } from './mailbox.js'
export { Artefacts } from './artefacts.js'
export type { ArtefactField } from './artefacts.js'
export { bootApp, stopApp } from './boot.js'
export type { BootOutcome, BootOpts } from './boot.js'
export { isolatedHealthUrl, isolateRun, mintIsolation } from './isolation.js'
export type { RunIsolation } from './isolation.js'
export { reapProjects } from './reap.js'
export type { ReapOutcome, ReapOpts } from './reap.js'
export { installCancelCleanup, runJob } from './run.js'
export type { FlowSessionFactory } from './run.js'
export { runVisualCheck, type VisualRevision, type VisualCheckOpts, type VisualScreenshot, type VisualDiff, type VisualCheckResult } from './visual.js'
export { runFlowCheck, runSuiteCheck } from './flow.js'
export type { FlowAction, FlowElement, FlowPage, FlowTrace, FlowCheckOpts, FlowCheckResult, FlowTotpConfig, FlowDriverCapabilities } from './flow.js'
export { SNAPSHOT_SCHEMA_VERSION, nameFindings, normaliseAriaSnapshot, trimToSubtree } from './snapshot.js'
export type { SnapshotNode } from './snapshot.js'
export {
  LANDMARK_ROLES,
  REPAIRS_SCHEMA_VERSION,
  decideRepair,
  findCandidates,
  identityOfNode,
  identityOfPath,
  identityText,
  isSnapshotPath,
  landmarkAncestry,
  sameIdentity,
} from './locator.js'
export type { ElementIdentity, FlowRepairRecord, RepairDecision } from './locator.js'
export { decodeBase32, totpCode, totpWindow, windowRemaining } from './totp.js'
export {
  makePlaywrightScreenshot,
  disposeBrowser,
  PlaywrightScreenshotBackendError,
} from './visual-playwright.js'
export { BROWSER_FLOW_DRIVER, makePlaywrightFlowSession, PlaywrightFlowSessionError } from './flow-playwright.js'
export { matchesStub, summarizeEgress, mergeVerdicts } from './egress.js'
export type { EgressAttempt, EgressFinding, EgressStub } from './egress.js'
export { diffStubs, flagAddedStubs } from './stub-diff.js'
export type { StubDiff } from './stub-diff.js'
export {
  consumeVerifierFindings,
  detectRegressions,
  judgeRun,
  judgedResult,
  judgeExecuted,
  evidenceOf,
  prepareVerifierInputs,
  runVerifier,
  toSideResults,
  verdictOf,
  VERIFIER_OUTPUT_SCHEMA,
} from './judge.js'
export type {
  CriterionVerdict,
  JudgeRunInput,
  JudgeRunResult,
  JudgeExecutedOptions,
  Regression,
  SideResult,
  VerifierClaim,
  VerifierFinding,
  VerifierInputs,
} from './judge.js'
export { replayRun } from './replay.js'
export type { ReplayDifference, ReplayReport, StoredVerdict } from './replay.js'
export { renderComment, renderCheckRun } from './evidence.js'
export type { CheckRunPayload, EvidenceLinks, EvidencePoster } from './evidence.js'
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
export { applyLedgerProposal } from './ledger-apply.js'
export { integrityOf } from './ledger.js'
export {
  hasIngestComment,
  ingestCommentMarker,
  ingestCriteria,
  renderUncheckableComment,
} from './ledger-ingest.js'
export type { IngestSource, IngestOutcome, IngestDuplicate, UncheckableCriterion } from './ledger-ingest.js'
export { readinessInventory, buildReadinessReport, normalizeOrigin, parseComposeServices, READINESS_MAX_FILES } from './readiness.js'
export type {
  ReadinessInventory,
  ReadinessComposeFile,
  ReadinessOriginHit,
  ReadinessProfileInfo,
  ReadinessScanStats,
} from './readiness.js'
export {
  missingStubs,
  missingStubsFromResult,
  stubIssueDraft,
  stubIssueMarker,
  parseStubIssueMarkers,
  refusedRegistryLine,
  parseRefusedRegistry,
  requeueTargets,
} from './stub-issues.js'
export type { MissingStub, StubIssueDraft, StubIssueRefusedEntry, StubIssuePoster } from './stub-issues.js'
export { CheckInputError, checkCriteria, defaultCheckEvidenceDir, nareRunners } from './check.js'
export type { CheckOptions, CheckOutcome } from './check.js'
export { detectExecution, runEnvironment } from './environment.js'
export type { ExecutionKind, RunEnvironment } from './environment.js'
export { runDoctor } from './doctor.js'
export type { DoctorFinding, DoctorProbes, DoctorReport } from './doctor.js'
