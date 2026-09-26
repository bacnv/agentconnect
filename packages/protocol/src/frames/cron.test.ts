import { describe, expect, it } from 'vitest'
import { CronAuthor, CronAuthorOk, CronUpsert } from './cron.js'

const wireCron = {
  cronId: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222',
  schedule: '0 9 * * *',
  timezone: 'Asia/Singapore',
  trigger: 'post the daily report',
  enabled: true
}

describe('CronUpsert', () => {
  it('requires and preserves the resolved IANA timezone', () => {
    expect(CronUpsert.parse(wireCron).timezone).toBe('Asia/Singapore')

    const { timezone: _, ...missingTimezone } = wireCron
    expect(CronUpsert.safeParse(missingTimezone).success).toBe(false)
  })
})

const wireAuthor = {
  requestId: '33333333-3333-4333-8333-333333333333',
  agentId: '22222222-2222-4222-8222-222222222222',
  schedule: '30 6 * * *',
  timezone: 'Asia/Ho_Chi_Minh',
  trigger: 'chúc cả nhà buổi sáng',
  target: {
    platform: 'telegram',
    channel: '-1001234567890',
    integrationId: '44444444-4444-4444-8444-444444444444'
  }
}

describe('CronAuthor', () => {
  it('carries the target the daemon resolved, and requires one', () => {
    expect(CronAuthor.parse(wireAuthor).target.channel).toBe('-1001234567890')

    const { target: _, ...headless } = wireAuthor
    // Absent (not merely empty) is the refusal: an authored cron always posts somewhere.
    expect(CronAuthor.safeParse(headless).success).toBe(false)
  })

  it('requires a timezone rather than defaulting one', () => {
    const { timezone: _, ...missingTimezone } = wireAuthor
    expect(CronAuthor.safeParse(missingTimezone).success).toBe(false)
    expect(CronAuthor.parse(wireAuthor).timezone).toBe('Asia/Ho_Chi_Minh')
  })
})

describe('CronAuthorOk', () => {
  it('answers with the id the CP minted and the resolved next fire time', () => {
    const ok = {
      cronId: '55555555-5555-4555-8555-555555555555',
      schedule: '30 6 * * *',
      timezone: 'Asia/Ho_Chi_Minh',
      nextRun: '2026-09-27T23:30:00.000Z'
    }
    expect(CronAuthorOk.parse(ok)).toEqual(ok)
    expect(CronAuthorOk.safeParse({ ...ok, nextRun: null }).success).toBe(false)
  })
})
