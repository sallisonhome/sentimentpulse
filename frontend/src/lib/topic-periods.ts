import type { Period } from '../types'

export const TOPIC_PERIOD_MESSAGE =
  'Top Topics are only available for Today, 7 Day and 30 Day time periods.'

export function supportsTopics(period: Period): boolean {
  return period === 'today' || period === 'weekly' || period === 'monthly'
}
