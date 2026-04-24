import { useEffect, useState } from 'react'
import {
  type kaiAILimits,
  currentLimits,
  statusListeners,
} from './kaiAILimits.js'

export function usekaiAILimits(): kaiAILimits {
  const [limits, setLimits] = useState<kaiAILimits>({ ...currentLimits })

  useEffect(() => {
    const listener = (newLimits: kaiAILimits) => {
      setLimits({ ...newLimits })
    }
    statusListeners.add(listener)

    return () => {
      statusListeners.delete(listener)
    }
  }, [])

  return limits
}
