/** Public feature-owned tabs in the Usage statistics settings section. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Owner props supplied by the Usage statistics section's render site. */
export interface UsageStatisticsTabOwnerProps {
  /** Close the settings dialog when a page navigates to a session. */
  close: () => void
  /** Whether this retained page is selected; inactive pages pause polling. */
  active: boolean
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Ordered statistics pages with registrant-owned id, order and label. */
    'settings.usage-statistics.tab': {
      kind: 'list'
      scope: 'root'
      owner: UsageStatisticsTabOwnerProps
    }
  }
}
