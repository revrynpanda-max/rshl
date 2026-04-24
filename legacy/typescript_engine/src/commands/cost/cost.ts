import { formatTotalCost } from '../../cost-tracker.js'
import { currentLimits } from '../../services/kaiAILimits.js'
import type { LocalCommandCall } from '../../types/command.js'
import { iskaiAISubscriber } from '../../utils/auth.js'

export const call: LocalCommandCall = async () => {
  if (iskaiAISubscriber()) {
    let value: string

    if (currentLimits.isUsingOverage) {
      value =
        'You are currently using your overages to power your KAI usage. We will automatically switch you back to your local access rate limits when they reset'
    } else {
      value =
        'You are currently using your local access to power your KAI usage'
    }

    if (process.env.USER_TYPE === 'ant') {
      value += `\n\n[ANT-ONLY] Showing cost anyway:\n ${formatTotalCost()}`
    }
    return { type: 'text', value }
  }
  return { type: 'text', value: formatTotalCost() }
}
