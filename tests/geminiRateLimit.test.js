// Mock logger to keep test output clean
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

// Mock token refresh logger side effects
jest.mock('../src/utils/tokenRefreshLogger', () => ({
  logRefreshStart: jest.fn(),
  logRefreshSuccess: jest.fn(),
  logRefreshError: jest.fn(),
  logTokenUsage: jest.fn(),
  logRefreshSkipped: jest.fn()
}))

// Mock Redis client
jest.mock('../src/models/redis', () => {
  const mockClient = {
    hgetall: jest.fn(),
    hset: jest.fn().mockResolvedValue(undefined),
    smembers: jest.fn(),
    get: jest.fn(),
    setex: jest.fn()
  }

  return {
    getClientSafe: jest.fn(() => mockClient),
    __mockClient: mockClient
  }
})

describe('Gemini rate limit helpers', () => {
  afterEach(() => {
    jest.useRealTimers()
    jest.resetModules()
  })

  it('uses rateLimitEndAt when rateLimitedAt is missing', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2025-01-01T00:00:00Z'))

    const redis = require('../src/models/redis')
    const mockClient = redis.__mockClient
    const endAt = new Date('2025-01-01T00:10:00Z').toISOString()

    mockClient.hgetall.mockImplementation(async (key) => {
      if (key === 'gemini_account:acct-1') {
        return {
          id: 'acct-1',
          rateLimitStatus: 'limited',
          rateLimitEndAt: endAt,
          rateLimitReason: 'RATE_LIMIT_EXCEEDED',
          schedulable: 'true'
        }
      }
      return {}
    })

    const geminiAccountService = require('../src/services/geminiAccountService')
    const info = await geminiAccountService.getAccountRateLimitInfo('acct-1')

    expect(info.isRateLimited).toBe(true)
    expect(info.rateLimitReason).toBe('RATE_LIMIT_EXCEEDED')
    expect(info.minutesRemaining).toBe(10)
    expect(info.rateLimitEndAt).toBe(endAt)
  })

  it('clears expired rateLimitEndAt states', async () => {
    const redis = require('../src/models/redis')
    const mockClient = redis.__mockClient
    const expiredEndAt = new Date(Date.now() - 1000).toISOString()

    mockClient.hgetall.mockImplementation(async (key) => {
      if (key === 'gemini_account:acct-2') {
        return {
          id: 'acct-2',
          rateLimitStatus: 'limited',
          rateLimitEndAt: expiredEndAt,
          rateLimitReason: 'RATE_LIMIT_EXCEEDED',
          schedulable: 'true'
        }
      }
      return {}
    })

    const geminiAccountService = require('../src/services/geminiAccountService')
    const info = await geminiAccountService.getAccountRateLimitInfo('acct-2')

    expect(info.isRateLimited).toBe(false)
    expect(info.minutesRemaining).toBe(0)
    expect(info.rateLimitEndAt).toBe(null)

    await new Promise((resolve) => setImmediate(resolve))

    expect(mockClient.hset).toHaveBeenCalledWith(
      'gemini_account:acct-2',
      expect.objectContaining({
        rateLimitStatus: '',
        rateLimitedAt: '',
        rateLimitReason: '',
        rateLimitRetryAfterSec: '',
        rateLimitEndAt: ''
      })
    )
  })

  it('skips accounts still limited by rateLimitEndAt when selecting', async () => {
    const redis = require('../src/models/redis')
    const mockClient = redis.__mockClient
    const now = Date.now()
    const futureEndAt = new Date(now + 10 * 60 * 1000).toISOString()
    const pastEndAt = new Date(now - 1000).toISOString()
    const futureExpiry = new Date(now + 60 * 60 * 1000).toISOString()

    const store = {
      'api_key:test-key': {},
      'gemini_account:acct-1': {
        id: 'acct-1',
        isActive: 'true',
        rateLimitStatus: 'limited',
        rateLimitEndAt: futureEndAt,
        lastUsedAt: '2024-01-01T00:00:00Z',
        expiresAt: futureExpiry,
        subscriptionExpiresAt: '',
        schedulable: 'true'
      },
      'gemini_account:acct-2': {
        id: 'acct-2',
        isActive: 'true',
        rateLimitStatus: 'limited',
        rateLimitEndAt: pastEndAt,
        lastUsedAt: '2024-01-02T00:00:00Z',
        expiresAt: futureExpiry,
        subscriptionExpiresAt: '',
        schedulable: 'true'
      }
    }

    mockClient.hgetall.mockImplementation(async (key) => {
      const value = store[key]
      return value ? { ...value } : {}
    })
    mockClient.get.mockResolvedValue(null)
    mockClient.smembers.mockResolvedValue(['acct-1', 'acct-2'])

    const geminiAccountService = require('../src/services/geminiAccountService')
    const selected = await geminiAccountService.selectAvailableAccount('test-key')

    expect(selected.id).toBe('acct-2')
  })
})
