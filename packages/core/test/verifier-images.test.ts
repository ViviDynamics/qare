import { expect, test } from 'vitest'
import { prepareVerifierInputs, verifierImageInput } from '../src/index.js'

// #439: the verifier was never told it could not see screenshots, so it
// reported "final.png could not be reviewed" as if the evidence fell short.
// Whether it can see them is the caller's to declare: nare does not guess a
// model's capability, and a text-only model declared capable errors.

const INPUT = {
  criteria: [{ criterionId: 'c1', outcome: 'proven' as const, evidence: ['head/checks/c1/0/final.png'] }],
  texts: { c1: 'The blog index shows the post' },
  evidence: { c1: ['head/checks/c1/0/actions.log', 'head/checks/c1/0/final.png'] },
  diff: '',
}

test('the verifier image setting is off unless the environment turns it on, and refuses anything but true or false (#439)', () => {
  expect(verifierImageInput({})).toBe(false)
  expect(verifierImageInput({ QARE_VERIFIER_IMAGE_INPUT: '' })).toBe(false)
  expect(verifierImageInput({ QARE_VERIFIER_IMAGE_INPUT: 'false' })).toBe(false)
  expect(verifierImageInput({ QARE_VERIFIER_IMAGE_INPUT: 'true' })).toBe(true)
  expect(() => verifierImageInput({ QARE_VERIFIER_IMAGE_INPUT: 'yes' })).toThrow(/QARE_VERIFIER_IMAGE_INPUT is "yes"/)
})

test('a verifier that cannot see images is told so, and to judge from the text evidence (#439)', () => {
  const { instructions } = prepareVerifierInputs({ ...INPUT, imageInput: false })

  expect(instructions).toContain('You cannot see the screenshots')
  expect(instructions).toContain('A screenshot you cannot open is no finding on its own')
  expect(instructions).not.toContain('You can read the screenshots')
})

test('a verifier that can see images is told to read the screenshots (#439)', () => {
  const { instructions } = prepareVerifierInputs({ ...INPUT, imageInput: true })

  expect(instructions).toContain('You can read the screenshots')
  expect(instructions).not.toContain('You cannot see the screenshots')
})

test('the instructions follow the environment when the caller does not say (#439)', () => {
  const previous = process.env.QARE_VERIFIER_IMAGE_INPUT
  try {
    process.env.QARE_VERIFIER_IMAGE_INPUT = 'true'
    expect(prepareVerifierInputs(INPUT).instructions).toContain('You can read the screenshots')
    delete process.env.QARE_VERIFIER_IMAGE_INPUT
    expect(prepareVerifierInputs(INPUT).instructions).toContain('You cannot see the screenshots')
  } finally {
    if (previous === undefined) delete process.env.QARE_VERIFIER_IMAGE_INPUT
    else process.env.QARE_VERIFIER_IMAGE_INPUT = previous
  }
})
