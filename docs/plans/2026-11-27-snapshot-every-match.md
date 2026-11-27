# A text assertion's snapshot keeps only the first match

Issue #439

## Scope
In: the snapshot written at a text assertion keeps every node whose name holds the
asserted text, each with its ancestors. The verifier is told whether it can see
screenshots, and a new pipeline input, `nare-image-input`, declares a model that takes
images so the verifier reads them through nare's `--image-input`.
Out: turning image input on by default. nare does not guess a model's capability and a
text-only model declared capable errors, so only the caller can declare it.

## Assumptions
- Why the verifier could not review `final.png`: nare's `read` returns an image only
  under `--image-input`, which qare never passed. The pilot's model is reached through
  an OpenAI-compatible proxy, whose image support qare cannot know.
- Off, the verifier is told it cannot see screenshots and to judge from the text files,
  so a screenshot it cannot open is no finding on its own.

## Tasks
- [x] 1. `trimToSubtree` keeps every match: snapshot tests with an img alt before a heading.
- [x] 2. The verifier runner declares `--image-input` when `QARE_VERIFIER_IMAGE_INPUT` is true, the planner never: runner tests.
- [x] 3. The verifier's instructions say whether it can see screenshots: verifier tests.
- [x] 4. The pipeline's `nare-image-input` reaches only the judge containers, refused unless true or false: pipeline tests.
- [x] 5. Docs: pipeline.md input table.
