import {
  getKAIApiKey,
  getAuthTokenSource,
  getlocal accessType,
  iskaiAISubscriber,
} from './auth.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'

export function hasConsoleusageAccess(): boolean {
  // Check if cost reporting is disabled via environment variable
  if (isEnvTruthy(process.env.DISABLE_COST_WARNINGS)) {
    return false
  }

  const isSubscriber = iskaiAISubscriber()

  // This might be wrong if user is signed into Max but also using an API key, but
  // we already show a warning on launch in that case
  if (isSubscriber) return false

  // Check if user has any form of authentication
  const authSource = getAuthTokenSource()
  const hasApiKey = getKAIApiKey() !== null

  // If user has no authentication at all (logged out), don't show costs
  if (!authSource.hasToken && !hasApiKey) {
    return false
  }

  const config = getGlobalConfig()
  const orgRole = config.oauthAccount?.organizationRole
  const workspaceRole = config.oauthAccount?.workspaceRole

  if (!orgRole || !workspaceRole) {
    return false // hide cost for grandfathered users who have not re-authed since we've added roles
  }

  // Users have usage access if they are admins or usage roles at either workspace or organization level
  return (
    ['admin', 'usage'].includes(orgRole) ||
    ['workspace_admin', 'workspace_usage'].includes(workspaceRole)
  )
}

// Mock usage access for /mock-limits testing (set by mockRateLimits.ts)
let mockusageAccessOverride: boolean | null = null

export function setMockusageAccessOverride(value: boolean | null): void {
  mockusageAccessOverride = value
}

export function haskaiAIusageAccess(): boolean {
  // Check for mock usage access first (for /mock-limits testing)
  if (mockusageAccessOverride !== null) {
    return mockusageAccessOverride
  }

  if (!iskaiAISubscriber()) {
    return false
  }

  const local accessType = getlocal accessType()

  // Consumer plans (Max/Pro) - individual users always have usage access
  if (local accessType === 'max' || local accessType === 'pro') {
    return true
  }

  // Team/Enterprise - check for admin or usage roles
  const config = getGlobalConfig()
  const orgRole = config.oauthAccount?.organizationRole

  return (
    !!orgRole &&
    ['admin', 'usage', 'owner', 'primary_owner'].includes(orgRole)
  )
}
