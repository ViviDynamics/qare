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
export { shardCriteria, criterionOwnBoot } from './shards.js'
export type { LanePlan } from './shards.js'
export {
  RESULT_SCHEMA_VERSION,
  RUN_VERDICTS,
  ResultValidationError,
  loadResult,
  parseResult,
} from './result.js'
export { ProfileMissingError, ProfileValidationError, loadProfile, pathOnTarget, validateProfileConfig } from './profile.js'
export {
  BUILTIN_REDACTION_RULES,
  REDACTED,
  RedactionError,
  mailEvidenceRules,
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
  ProfileCommand,
  ProfileMcpServer,
  ProfileMcpToolMap,
  McpStep,
} from './profile.js'
export { CLIENT_DRIVERS, MCP_DRIVER_INTENTS } from './profile.js'
export type { ClientDriver, ProfileClient } from './profile.js'
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
  RunBase,
  CriterionBase,
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
export { EXECUTE_PATH_TOOLS, NO_DIFF, PLAN_OUTPUT_SCHEMA, PlanStepError, planOutputSchema, planRun } from './plan-step.js'
export type { DeclaredRunInputs, PlanCriterionInput, PlanInputs } from './plan-step.js'
export { JobValidationError, loadJobFromFile, loadJobFromText, parseJob } from './job.js'
export type { Job, JobProfileRef, JobCriterion, JobCommandCheck, JobFlowCheck, JobVisualCheck, JobA11yCheck, JobCheck, JobPostTarget, JobProfileGroup, SingleProfileJob, SeveralProfilesJob } from './job.js'
export { httpMailbox, mailEvidence, runMailCheck, extractCode, DEFAULT_CODE_PATTERN } from './mailbox.js'
export type { MailMessage, MailEvidenceMessage, MailOutcome, MailProof, ReadMail } from './mailbox.js'
export { inboxSource, mailpitSource, mailReader, mailSourceOf, MAIL_SOURCE_KINDS } from './mail-source.js'
export type { MailSource, MailFilter, MailRef, DeclaredMailSource, MailSourceKind } from './mail-source.js'
export { Artefacts } from './artefacts.js'
export type { ArtefactField } from './artefacts.js'
export { bootApp, stopApp } from './boot.js'
export type { BootOutcome, BootOpts } from './boot.js'
export { isolatedHealthUrl, isolateRun, mintIsolation } from './isolation.js'
export type { RunIsolation } from './isolation.js'
export { reapProjects } from './reap.js'
export type { ReapOutcome, ReapOpts } from './reap.js'
export { installCancelCleanup, runJob } from './run.js'
export { prepareBaseCheckout } from './base-checkout.js'
export type { BaseCheckout, BaseCheckoutInput, BaseCheckoutOutcome } from './base-checkout.js'
export type { BaseSideRequest, FlowSessionFactory, MailSourceFactory, RunJobOpts, RunJobOutcome } from './run.js'
export {
  collectCriterionFiles,
  criterionCacheKey,
  FileCheckCache,
  planFingerprint,
  profileFingerprint,
  resolveRefSha,
  stableStringify,
} from './cache.js'
export type { CacheKeyParts, CachedCriterion, CachedFile, CheckCache } from './cache.js'
export {
  QUARANTINE_FILE,
  QUARANTINE_SCHEMA_VERSION,
  addQuarantineRecord,
  checkFingerprint,
  openQuarantine,
  quarantineCheckName,
  quarantinedRecord,
  readQuarantine,
  saveQuarantine,
} from './quarantine.js'
export type { QuarantineContext, QuarantineRecord } from './quarantine.js'
export { runVisualCheck, type VisualRevision, type VisualCheckOpts, type VisualScreenshot, type VisualDiff, type VisualCheckResult } from './visual.js'
export { decodePng, diffPngs, encodePng, PngError, type PngImage } from './png.js'
export { playwrightVisualSession, runVisualCheckJob, visualPageUrl, VISUAL_RECORD } from './visual-run.js'
export type { VisualCheckJobInput, VisualCheckJobOutcome, VisualComparison, VisualContext, VisualSessionFactory } from './visual-run.js'
export { A11Y_IMPACTS, A11Y_STANDARDS, DEFAULT_A11Y_FAIL, DEFAULT_A11Y_STANDARD, a11yConfigOf, decideA11y, pageOf } from './a11y.js'
export type {
  A11yAccepted,
  A11yAuditNode,
  A11yAuditRequest,
  A11yAuditViolation,
  A11yBaseline,
  A11yConfig,
  A11yCounts,
  A11yDecision,
  A11yFinding,
  A11yFlowAudit,
  A11yFlowAudits,
  A11yImpact,
  A11yPageAudit,
  A11yStatus,
  ProfileA11y,
} from './a11y.js'
export { A11Y_RECORD, DEFAULT_A11Y_THEME, settleA11y } from './a11y-run.js'
export type { A11yContext, A11ySettleInput, A11ySettleOutcome } from './a11y-run.js'
// The advisory UX review (#150): findings a person reads, never a verdict.
export {
  ADVISORY_CATEGORIES,
  ADVISORY_SEVERITIES,
  UX_REVIEW_OUTPUT_SCHEMA,
  UX_REVIEW_TIMEOUT_MS,
  advisoryFindingId,
  advisoryScreens,
  consumeUxFindings,
  reviewJudged,
  runUxReview,
} from './advisory.js'
export type {
  AdvisoryCategory,
  AdvisoryFinding,
  AdvisoryScreen,
  AdvisorySeverity,
  DismissedFinding,
  ReviewJudgedOptions,
  RunAdvisory,
  UxReviewInputs,
} from './advisory.js'
export type { ProfileUx } from './profile.js'
export type { ProfileFindings } from './profile.js'
export { ADVISORY_DISMISS_COMMAND, ADVISORY_PROMOTE_COMMAND, renderAdvisorySection } from './advisory-comment.js'
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
  outboundOf,
  PlaywrightScreenshotBackendError,
} from './visual-playwright.js'
export { BROWSER_FLOW_DRIVER, makePlaywrightFlowSession, PlaywrightFlowSessionError } from './flow-playwright.js'
export { ELECTRON_FLOW_DRIVER } from './flow-electron.js'
export { flowDriverFor } from './flow-driver.js'
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
  toBaseSideResults,
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
export { codeSpan, renderComment, renderCheckRun } from './evidence.js'
export type { CheckRunPayload, EvidenceLinks, EvidencePoster } from './evidence.js'
export { classifyPipelineFailure, renderPipelineFailureCheckRun, renderPipelineFailureComment } from './pipeline-failure.js'
export type { PipelineFailure, PipelineFailureReport, PipelineJob, PipelineStep } from './pipeline-failure.js'
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
  appendChange,
  parseLedgerDocument,
  parseLedgerEntries,
  serializeLedger,
  serializeLedgerDocument,
} from './ledger.js'
export type {
  LedgerEntry,
  LedgerStatus,
  LedgerStore,
  LedgerResolution,
  LedgerChange,
  LedgerChangeKind,
  LedgerDocument,
  ResolutionClassification,
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
export {
  renderCriteriaMarkdown,
  renderHistoryMarkdown,
  verificationBuckets,
} from './ledger-publish.js'
export type { VerificationBuckets } from './ledger-publish.js'
export { integrityOf } from './ledger.js'
export {
  CONTRADICTION_SCHEMA_VERSION,
  ContradictionClassifierError,
  detectContradictions,
  executedFromResult,
} from './ledger-contradict.js'
export type {
  Contradiction,
  ContradictionChange,
  ContradictionInput,
  ContradictionReport,
  ExecutedCriterion,
  IntroducedCriterion,
} from './ledger-contradict.js'
export {
  affectedBy,
  holdForQuestions,
  questionIdFor,
  questionMarker,
  QUESTION_MARKER_PREFIX,
  renderQuestion,
  resolveContradictions,
} from './ledger-resolve.js'
export type {
  ResolutionQuestion,
  ResolutionReport,
  ResolutionSource,
  SettledConflict,
} from './ledger-resolve.js'
export {
  hasIngestComment,
  ingestCommentMarker,
  ingestCriteria,
  renderUncheckableComment,
  WRITING_CRITERIA_GUIDE,
} from './ledger-ingest.js'
export type { IngestSource, IngestOutcome, IngestDuplicate, UncheckableCriterion } from './ledger-ingest.js'
export {
  checkTarget,
  selectCriteria,
  DEFAULT_SMOKE_SUITE,
  DEFAULT_SELECTION_BUDGET_MS,
} from './selection.js'
export type {
  CheckTarget,
  SelectedCriterion,
  UnselectedCriterion,
  SelectionReport,
  SelectionOptions,
  SelectedReason,
  UnselectedReason,
} from './selection.js'
export { resolveCriteriaSubset, criteriaSubsetPlan, CriteriaSubsetError } from './subset.js'
export type { ResolvedCriterion } from './subset.js'
export { readinessInventory, buildReadinessReport, normalizeOrigin, parseComposeServices, READINESS_MAX_FILES, INIT_PLACEHOLDER } from './readiness.js'
export type {
  ReadinessInventory,
  ReadinessComposeFile,
  ReadinessOriginHit,
  ReadinessProfileInfo,
  ReadinessScanStats,
  ReadinessStubGap,
  ReadinessComposeService,
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
export { INIT_DEFAULT_MODEL, INIT_MODEL_SECRET, INIT_WORKFLOW_PATH, InitError, PIPELINE_WORKFLOW, callerWorkflow, planInit } from './init.js'
export type { InitFile, InitOptions, InitPlan } from './init.js'
export type { MissingStub, StubIssueDraft, StubIssueScan, StubIssueRefusedEntry, StubIssuePoster } from './stub-issues.js'
export { CheckInputError, checkCriteria, defaultCheckEvidenceDir, nareRunners } from './check.js'
export type { CheckOptions, CheckOutcome } from './check.js'
export { detectExecution, runEnvironment } from './environment.js'
export type { ExecutionKind, RunEnvironment } from './environment.js'
export { NARE_PYTHON_MINIMUM, runDoctor } from './doctor.js'
export type { DoctorFinding, DoctorProbes, DoctorReport } from './doctor.js'
export {
  SWEEP_STATUS_KEY,
  SWEEP_STATUS_MARKER,
  DEFAULT_STALE_AFTER,
  areasOf,
  classifySweep,
  findingDraft,
  loadSweepConfigText,
  parseSweepConfig,
  readSweepConfig,
  loadHeldResult,
  renderFindingMarkdown,
  renderStatusMarkdown,
  statusDraft,
  statusReportMarker,
  sweepConfigFor,
  sweepFindingMarker,
  sweepLedger,
} from './sweep.js'
export type { SweepAreaConfig, SweepBucket, SweepClassification, SweepConfig, SweepFinding, SweepPayload, SweepReport } from './sweep.js'
export { SweepConfigValidationError, SweepLedgerError } from './sweep.js'
export {
  appendMetricsNote,
  appendRunMetrics,
  metricsSummaryLines,
  readMetricsStore,
  METRICS_SCHEMA_VERSION,
  NOTES_FILE,
  RUNS_FILE,
  summarizeMetrics,
  sumUsage,
} from './metrics.js'
export type { MetricsNote, MetricsNoteKind, MetricsStore, MetricsSummary, ModelUsage, RunMetricsRecord } from './metrics.js'
// Findings on main (#154): what a run on main amounts to, who it names, and what the issue says.
export * from './main-findings.js'
export * from './main-findings-blame.js'
export * from './main-findings-render.js'
