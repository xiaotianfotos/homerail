export {}

declare global {
  type DesktopUpdateState =
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'not-available'
    | 'error'

  type DesktopUpdateChannel = 'stable' | 'early-access'

  interface DesktopBrowserToolsStatus {
    supported: boolean
    enabled: boolean
    runtimeEnabled: boolean
    restartRequired: boolean
    state: 'disabled' | 'restart-required' | 'starting' | 'connected' | 'unavailable' | 'error'
    error?: string
  }

  interface DesktopUpdateStatus {
    supported: boolean
    state: DesktopUpdateState
    currentVersion: string
    channel: DesktopUpdateChannel
    channelNotice?: 'waiting-for-newer-stable'
    update?: {
      version?: string
      releaseName?: string | null
      releaseDate?: string
    }
    error?: string
    checkedAt?: number
    downloadedAt?: number
    installStartedAt?: number
    downloadProgress?: {
      percent: number
      transferred: number
      total: number
      bytesPerSecond?: number
    }
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
    setUpdateChannel?: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateStatus>
    installUpdate?: () => Promise<DesktopUpdateStatus>
    onUpdateStatus?: (handler: (status: DesktopUpdateStatus) => void) => () => void
    browserToolsStatus?: () => Promise<DesktopBrowserToolsStatus>
    setBrowserToolsEnabled?: (enabled: boolean) => Promise<DesktopBrowserToolsStatus>
    onBrowserToolsStatus?: (handler: (status: DesktopBrowserToolsStatus) => void) => () => void
  }

  interface Window {
    homerailDesktop?: HomeRailDesktopBridge
  }
}
