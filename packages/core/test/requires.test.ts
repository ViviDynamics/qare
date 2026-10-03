import { expect, test } from 'vitest'
import { ProfileValidationError, validateProfileConfig } from '../src/index.js'

const TARGET = { target: { url: 'https://staging.example.com', health: { http: 'https://staging.example.com/up', timeout: '10s' } } }
const CLIENT = { client: { driver: 'electron', executable: 'dist/my-app' } }

function refusal(config: unknown): ProfileValidationError {
  try {
    validateProfileConfig(config)
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileValidationError)
    return error as ProfileValidationError
  }
  throw new Error('expected the profile to be refused')
}

test('a profile declares what it requires of the host: operating system, virtualisation, attached devices (#76)', () => {
  const profile = validateProfileConfig({ ...TARGET, requires: { os: 'macos', virtualisation: true, devices: ['android'] } })
  expect(profile.requires).toEqual({ os: 'macos', virtualisation: true, devices: ['android'] })
  // Each is optional, and a profile that requires nothing carries no section.
  expect(validateProfileConfig({ ...TARGET, requires: { os: 'linux' } }).requires).toEqual({ os: 'linux' })
  expect(validateProfileConfig({ ...TARGET, requires: { os: 'windows' } }).requires).toEqual({ os: 'windows' })
  expect(validateProfileConfig(TARGET).requires).toBeUndefined()
  // Saying a thing is not required is saying nothing.
  expect(validateProfileConfig({ ...TARGET, requires: { virtualisation: false, devices: [] } }).requires).toBeUndefined()
  // A client profile declares the same section.
  expect(validateProfileConfig({ client: { ...CLIENT.client, egress: 'uncontained' }, requires: { os: 'macos' } }).requires).toEqual({ os: 'macos' })
})

test('a requires section the run could not hold a host to is refused when the profile loads (#76)', () => {
  const shape = refusal({ ...TARGET, requires: 'macos' })
  expect(shape.field).toBe('requires')

  const key = refusal({ ...TARGET, requires: { gpu: true } })
  expect(key.field).toBe('requires.gpu')
  expect(key.message).toContain('requires takes os, virtualisation and devices, not "gpu"')

  const os = refusal({ ...TARGET, requires: { os: 'darwin' } })
  expect(os.field).toBe('requires.os')
  expect(os.message).toContain('requires.os must be one of linux, macos, windows, not "darwin"')

  const virtualisation = refusal({ ...TARGET, requires: { virtualisation: 'kvm' } })
  expect(virtualisation.field).toBe('requires.virtualisation')
  expect(virtualisation.message).toContain('true or false')

  const devices = refusal({ ...TARGET, requires: { devices: 'android' } })
  expect(devices.field).toBe('requires.devices')

  const kind = refusal({ ...TARGET, requires: { devices: ['android', 'toaster'] } })
  expect(kind.field).toBe('requires.devices[1]')
  expect(kind.message).toContain('must be one of android, not "toaster"')

  // A kind nothing can detect yet is refused by name, never accepted and never met.
  const ios = refusal({ ...TARGET, requires: { devices: ['ios'] } })
  expect(ios.field).toBe('requires.devices[0]')
  expect(ios.message).toContain('#74')

  const twice = refusal({ ...TARGET, requires: { devices: ['android', 'android'] } })
  expect(twice.field).toBe('requires.devices[1]')
  expect(twice.message).toContain('twice')
})

test('a contained client build is launched in a Linux cell, so it cannot require another operating system (#76)', () => {
  const contained = refusal({ ...CLIENT, requires: { os: 'macos' } })
  expect(contained.field).toBe('requires.os')
  expect(contained.message).toContain(
    'a contained build is launched in a cell, which is a Linux container, so it cannot require macos: a build for macos says client.egress: uncontained',
  )
  expect(refusal({ ...CLIENT, requires: { os: 'windows' } }).field).toBe('requires.os')
  // Linux is what the cell is, and an uncontained build runs on the host itself.
  expect(validateProfileConfig({ ...CLIENT, requires: { os: 'linux' } }).requires).toEqual({ os: 'linux' })
  expect(validateProfileConfig({ client: { ...CLIENT.client, egress: 'uncontained' }, requires: { os: 'windows' } }).requires).toEqual({ os: 'windows' })
})
