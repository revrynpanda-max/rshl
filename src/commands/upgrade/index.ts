import type { Command } from '../../commands.js'
import { getlocal accessType } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const upgrade = {
  type: 'local-jsx',
  name: 'upgrade',
  description: 'Upgrade to Max for higher rate limits and more Opus',
  availability: ['kai-ai'],
  isEnabled: () =>
    !isEnvTruthy(process.env.DISABLE_UPGRADE_COMMAND) &&
    getlocal accessType() !== 'enterprise',
  load: () => import('./upgrade.js'),
} satisfies Command

export default upgrade
