export {}

declare global {
  type DesktopUpdateState =
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'not-available'
    | 'error'

  interface DesktopUpdateStatus {
    supported: boolean
    state: DesktopUpdateState
    currentVersion: string
    update?: {
      version?: string
      releaseName?: string | null
      releaseDate?: string
    }
    error?: string
    checkedAt?: number
    downloadedAt?: number
  }

  interface HomeRailDesktopBridge {
    getStatus?: () => Promise<unknown>
    start?: () => Promise<unknown>
    stop?: () => Promise<unknown>
    restart?: () => Promise<unknown>
    doctor?: () => Promise<unknown>
    openLogs?: () => Promise<unknown>
    version?: () => Promise<unknown>
    updateStatus?: () => Promise<DesktopUpdateStatus>
    checkForUpdates?: () => Promise<DesktopUpdateStatus>
    installUpdate?: () => Promise<DesktopUpdateStatus>
    onUpdateStatus?: (handler: (status: DesktopUpdateStatus) => void) => () => void
  }

  interface Window {
    homerailDesktop?: HomeRailDesktopBridge
  }
}
