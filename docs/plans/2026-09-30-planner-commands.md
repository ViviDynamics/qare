# The planner reads QA.md and uses the commands the profile declares, instead of guessing

Issue #156

## Scope
In: an optional commands section on the .qa/ profile, loaded and validated when the profile loads; the planning prompt carrying the profile's QA.md instructions, redacted and size capped, and the declared commands; plan time refusal of a planned command whose program is neither the program of a declared command nor a standard tool of the executing job.
Out: qare init (#146, a separate future issue). No changes to how the run executes command checks, so a plan carries fully substituted commands and nothing new is expanded at run time. No new redaction rules; QA.md sweeps through the existing redact.ts sweep.

## Assumptions
- QaProfile gains an optional instructions field that loadProfile fills with the text of the profile's QA.md, the file it already stats. validateProfileConfig stays a pure config validator and does not read files.
- PlanInputs gains qaMd (the QA.md text) and commands (the declared commands). planRun redacts the text with the built in redaction sweep (redactText with BUILTIN_REDACTION_RULES) and caps it at 4000 characters, appending the visible note "QA.md was truncated at 4000 characters." A profile without QA.md text or without commands produces exactly the prompt it produces today.
- A declared command is a YAML map of name to { run, about }. The run string's {{name}} placeholders are the only substitution sites, and the planner fills them itself; there is no separate filter field. Validation at load time: the run string must survive the no shell contract (shellCharacter from duration.ts), every brace must be a well formed {{name}} token, run and about are non empty, and the name must be a safe name. Failures name the command.
- A plan time program gate runs only when the profile declares commands. A command check's program (its first token, placeholders or not) must be the program of a declared command's run string, or one of the standard tools the executing job carries (node, npm, git, jq, grep, test, the same vocabulary the prompt already names). Anything else is refused through the correction round and finally as a PlanStepError, naming the program, instead of a spawn ENOENT at run time. Without declared commands the gate is silent, so profiles that declare none behave as today.

## Tasks
- [ ] 1. Profile commands: the optional commands section loads and validates on boot and target profiles, with shell syntax, malformed placeholders and empty run or about refused by name: the profile.test.ts tests for a load, a shell refusal, a placeholder refusal and an about refusal.
- [ ] 2. The prompt carries QA.md and the declared commands, capped, redacted, and with an instruction to use the declared commands, while a profile without them is prompted as before: the plan-step.test.ts prompt tests plus the loadProfile test that the profile carries its instructions.
- [ ] 3. Plan time refusal of unknown programs, naming the program, with a declared command's invocation and a standard tool accepted: the plan-step.test.ts refusal and acceptance tests.
