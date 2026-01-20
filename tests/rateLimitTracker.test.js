// Mock logger to keep test output clean
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

// Mock Gemini account service to capture persistence calls
jest.mock('../src/services/geminiAccountService', () => ({
  setAccountRateLimitedWithDetails: jest.fn().mockResolvedValue(undefined),
  clearAccountRateLimit: jest.fn().mockResolvedValue(undefined)
}))

const { RateLimitTracker } = require('../src/services/antigravityEnhanced/rateLimitTracker')
const geminiAccountService = require('../src/services/geminiAccountService')

describe('RateLimitTracker', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('clears database rate limit once on first success', () => {
    const tracker = new RateLimitTracker()

    tracker.markSuccess('acct-1')
    tracker.markSuccess('acct-1')

    expect(geminiAccountService.clearAccountRateLimit).toHaveBeenCalledTimes(1)
    expect(geminiAccountService.clearAccountRateLimit).toHaveBeenCalledWith('acct-1')
  })

  it('persists rate limit details with retry window', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2025-01-01T00:00:00Z'))

    const tracker = new RateLimitTracker()
    const body = JSON.stringify({
      error: {
        details: [{ reason: 'RATE_LIMIT_EXCEEDED' }]
      }
    })

    tracker.parseFromError('acct-2', 429, '7', body)

    expect(geminiAccountService.setAccountRateLimitedWithDetails).toHaveBeenCalledTimes(1)
    expect(geminiAccountService.setAccountRateLimitedWithDetails).toHaveBeenCalledWith('acct-2', {
      reason: 'RATE_LIMIT_EXCEEDED',
      retryAfterSec: 7,
      rateLimitEndAt: '2025-01-01T00:00:07.000Z'
    })
  })
})
