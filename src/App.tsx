import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CommandPalette,
  ConnectionScreen,
  DdlViewerModal,
  ErrorBanner,
  HistoryPanel,
  MultiResultView,
  DatabaseExportModal,
  NewObjectModal,
  ObjectListPage,
  PluginPanelModal,
  PluginsSidebar,
  ToastViewport,
  notifyMutations,
  QueryPanel,
  SchemaBrowser,
  SchemaEditorModal,
  SettingsButton,
  SettingsPage,
  SearchPalette,
  TableObjectView,
  StatsDashboard,
  StatusBar,
  TabStrip,
  WelcomeDashboard,
  schemaDdl,
  sourceQuery,
  swatchFor,
  resolveHistoryLimit,
  ShortcutsCheatSheet,
  getModKeyLabel,
  isTypingTarget,
  useConnectionPrefs,
  useResolvedThemeMode,
  useHealthProbe,
  useRecentQueries,
  useTabsStore,
  useThemeStore,
  type ActivePlugin,
  type ColumnValue,
  type Command,
  type DatabaseStats,
  type DdlSourceKind,
  type HistoryEntry,
  type NewObjectKind,
  type ObjectListKind,
  type SidebarPanelInfo,
  type StreamedExportRequest,
  type StreamedExportResult,
  type StreamedExportRunner,
  type TableExportPart,
  type TableInfo,
  type ConnectionForm,
  type CryptState,
  type Profile,
  type ListAliasesResult,
  type Schema,
  type StatementOutcome,
  type TabState,
  type SchemaAction,
  type TestConnectionResult,
} from '@plamenix/ui';
import {
  History,
  Keyboard,
  LogOut,
  Moon,
  PanelLeftClose,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Sun,
  X,
} from 'lucide-react';
import { tauriTransport } from '@/transport/tauri';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

interface ConnectResponse {
  sessionId: string;
}

function deriveTitle(form: ConnectionForm): string {
  const last = form.database.split(/[\\/]/).pop() ?? form.database;
  return `${form.host}/${last}`;
}

/** Snapshot the persisted history-retention preference at call time so
 *  the dispatched execute carries the latest cap without forcing the
 *  surrounding `useCallback` to re-subscribe on every settings tweak. */
function currentHistoryLimit(): number | null {
  return resolveHistoryLimit(useConnectionPrefs.getState().queryHistoryLimit);
}

/** Stable key for the welcome-dashboard recent-queries bucket. Prefers
 *  the profile name so multiple tabs against the same profile share a
 *  list; falls back to host/db so anonymous connections still bucket
 *  cleanly. */
function recentKeyOf(form: ConnectionForm, profileName: string): string {
  const trimmed = profileName.trim();
  return trimmed.length > 0 ? trimmed : deriveTitle(form);
}

function recordExec(
  key: string,
  sql: string,
  startedAt: number,
  outcomes: StatementOutcome[] | null,
  err: string | null,
): void {
  const durationMs = Date.now() - startedAt;
  let status: 'ok' | 'err' = 'ok';
  let rowCount: number | null = null;
  let errMsg: string | null = null;
  if (err !== null) {
    status = 'err';
    errMsg = err;
  } else if (outcomes && outcomes.length > 0) {
    const failed = outcomes.find((o) => o.status === 'err');
    if (failed && failed.status === 'err') {
      status = 'err';
      errMsg = failed.error;
    } else {
      const last = outcomes[outcomes.length - 1];
      if (last && last.status === 'ok') {
        if ('Rows' in last.result) rowCount = last.result.Rows.rows.length;
        else if ('Affected' in last.result) rowCount = last.result.Affected.rows;
      }
    }
  }
  useRecentQueries.getState().record(key, {
    sql,
    executedAt: startedAt,
    durationMs,
    status,
    rowCount,
    error: errMsg,
  });
}

/** Renders an epoch-ms timestamp as a short relative-time string. The
 *  unused `_tick` argument forces a re-render when the parent's ticker
 *  advances; the value itself is discarded. */
function formatRelative(at: number, _tick: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

export function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const newTab = useTabsStore((s) => s.newTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const setActive = useTabsStore((s) => s.setActive);
  const patchTab = useTabsStore((s) => s.patchTab);
  const renameTab = useTabsStore((s) => s.renameTab);
  const reorderTab = useTabsStore((s) => s.reorderTab);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!;

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [aliasesData, setAliasesData] = useState<ListAliasesResult | null>(null);
  const [aliasesLoading, setAliasesLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsFetchedAt, setStatsFetchedAt] = useState<number | null>(null);
  const [statsTick, setStatsTick] = useState(0);

  const [ddlViewer, setDdlViewer] = useState<{
    kind: DdlSourceKind;
    name: string;
    source: string | null;
    loading: boolean;
    error: string | null;
  } | null>(null);

  const [plugins, setPlugins] = useState<ActivePlugin[]>([]);
  const [openPluginPanel, setOpenPluginPanel] = useState<{
    plugin: ActivePlugin;
    panel: SidebarPanelInfo;
  } | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const fetchPlugins = async () => {
      try {
        const list = await tauriTransport.invoke<ActivePlugin[]>('plugin_list_active');
        setPlugins(list);
      } catch {
        // Plugins are best-effort; never block the shell on a load failure.
      }
    };
    // First fetch at mount in case the bootstrap already finished (e.g.
    // window reloaded after first launch). The `boot:ready` listener
    // catches the cold-start race where the main window mounts before
    // the plugin bootstrap completes.
    void fetchPlugins();
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen('boot:ready', () => {
        void fetchPlugins();
      }).then((fn) => {
        unlisten = fn;
      }),
    );
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleGrantPermission = useCallback(async (pluginId: string, permission: string) => {
    try {
      const next = await tauriTransport.invoke<ActivePlugin[]>('plugin_grant_permission', {
        pluginId,
        permission,
      });
      setPlugins(next);
      setOpenPluginPanel((prev) =>
        prev ? { ...prev, plugin: next.find((p) => p.id === prev.plugin.id) ?? prev.plugin } : prev,
      );
    } catch {
      // ignore — UI keeps prior state
    }
  }, []);

  const handleRevokePermission = useCallback(async (pluginId: string, permission: string) => {
    try {
      const next = await tauriTransport.invoke<ActivePlugin[]>('plugin_revoke_permission', {
        pluginId,
        permission,
      });
      setPlugins(next);
      setOpenPluginPanel((prev) =>
        prev ? { ...prev, plugin: next.find((p) => p.id === prev.plugin.id) ?? prev.plugin } : prev,
      );
    } catch {
      // ignore
    }
  }, []);

  const refreshStats = useCallback(
    async (sessionId: string) => {
      setStatsLoading(true);
      setStatsError(null);
      try {
        const next = await tauriTransport.invoke<DatabaseStats>('db_database_stats', {
          sessionId,
        });
        setStats(next);
        setStatsFetchedAt(Date.now());
      } catch (err) {
        setStatsError(String(err));
      } finally {
        setStatsLoading(false);
      }
    },
    [],
  );

  const openStats = useCallback(() => {
    if (!activeTab.sessionId) return;
    setStatsOpen(true);
    void refreshStats(activeTab.sessionId);
  }, [activeTab.sessionId, refreshStats]);

  useEffect(() => {
    if (!statsOpen) return;
    const id = window.setInterval(() => setStatsTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [statsOpen]);

  const handleShowDdl = useCallback(
    async (kind: DdlSourceKind, name: string) => {
      const tab = activeTab;
      if (!tab.sessionId) return;
      setDdlViewer({ kind, name, source: null, loading: true, error: null });
      try {
        const sql = sourceQuery(kind, name);
        const outcomes = await tauriTransport.invoke<StatementOutcome[]>('db_execute', {
          request: {
            sessionId: tab.sessionId,
            sql,
            profileId: null,
            historyLimit: currentHistoryLimit(),
          },
        });
        const first = outcomes[0];
        if (!first) throw new Error('Source query produced no outcome.');
        if (first.status === 'err') throw new Error(first.error);
        if (!('Rows' in first.result)) {
          throw new Error('Source query did not return a row.');
        }
        const cell = first.result.Rows.rows[0]?.cells[0];
        let source = '';
        if (cell?.type === 'text') source = cell.value;
        else if (cell?.type === 'null') source = '';
        setDdlViewer({ kind, name, source, loading: false, error: null });
      } catch (err) {
        setDdlViewer({
          kind,
          name,
          source: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeTab],
  );

  const openHistory = useCallback(async () => {
    const pid = activeTab.selectedProfileId;
    if (!pid) return;
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const res = await tauriTransport.invoke<HistoryEntry[]>('history_list', {
        request: { profileId: pid, limit: 200 },
      });
      setHistoryEntries(res);
    } catch (err) {
      patchTab(activeTabId, { error: String(err) });
      setHistoryEntries([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [activeTab, activeTabId, patchTab]);

  const clearHistory = useCallback(async () => {
    const pid = activeTab.selectedProfileId;
    if (!pid) return;
    try {
      await tauriTransport.invoke<number>('history_clear', { profileId: pid });
      setHistoryEntries([]);
    } catch (err) {
      patchTab(activeTabId, { error: String(err) });
    }
  }, [activeTab, activeTabId, patchTab]);

  const deleteHistoryEntry = useCallback(
    async (id: number) => {
      await tauriTransport.invoke<boolean>('history_delete', { id });
      setHistoryEntries((prev) => (prev ? prev.filter((e) => e.id !== id) : prev));
    },
    [],
  );

  const deleteHistoryEntries = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) return;
      await tauriTransport.invoke<number>('history_delete_many', {
        request: { ids },
      });
      const drop = new Set(ids);
      setHistoryEntries((prev) =>
        prev ? prev.filter((e) => !drop.has(e.id)) : prev,
      );
    },
    [],
  );

  const setHistoryLabel = useCallback(
    async (id: number, label: string | null) => {
      await tauriTransport.invoke<boolean>('history_set_label', {
        request: { id, label },
      });
      const normalized =
        label && label.trim().length > 0 ? label.trim() : null;
      // Apply the change in-place rather than re-fetching the whole
      // list — keeps the optimistic UX snappy and avoids the modal
      // flickering when the panel is wide.
      let matched: { sql: string; executedAt: number } | null = null;
      setHistoryEntries((prev) => {
        if (!prev) return prev;
        return prev.map((entry) => {
          if (entry.id !== id) return entry;
          matched = { sql: entry.sql, executedAt: entry.executedAt };
          return { ...entry, label: normalized };
        });
      });
      // Propagate to the in-memory recent-queries store so the welcome
      // dashboard snippet reflects the rename without a re-fetch.
      if (matched) {
        const tab = activeTab;
        const key = recentKeyOf(tab.form, tab.profileName);
        useRecentQueries.getState().setLabel(key, matched, normalized);
      }
    },
    [activeTab],
  );

  const handleListAliases = useCallback(async () => {
    setAliasesLoading(true);
    try {
      const res = await tauriTransport.invoke<ListAliasesResult>('db_list_aliases');
      setAliasesData(res);
    } catch {
      setAliasesData({ sourcePath: null, aliases: [] });
    } finally {
      setAliasesLoading(false);
    }
  }, []);

  const handleBrowseFbclient = useCallback(async (): Promise<string | null> => {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const isWindows = navigator.platform.toLowerCase().includes('win');
    const extensions = isMac
      ? ['dylib']
      : isWindows
      ? ['dll']
      : ['so', 'so.*'];
    const result = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: 'Firebird client library', extensions }],
    });
    return typeof result === 'string' ? result : null;
  }, []);

  const handleBrowseFbclientDir = useCallback(async () => {
    const picked = await openDialog({ multiple: false, directory: true });
    if (typeof picked !== 'string') return null;
    const inspection = await tauriTransport.invoke<{
      fbclientPath: string | null;
      hasFbcrypt: boolean;
      hasOpenssl: boolean;
    }>('fbclient_inspect_dir', { dir: picked });
    return inspection;
  }, []);

  const handleDownloadFbclient = useCallback(
    async (version?: string): Promise<string> => {
      const res = await tauriTransport.invoke<{ path: string; version: string }>(
        'fbclient_download',
        version === undefined ? {} : { version },
      );
      return res.path;
    },
    [],
  );

  const [fbclientReleases, setFbclientReleases] = useState<
    { version: string }[] | null
  >(null);
  useEffect(() => {
    void tauriTransport
      .invoke<{ version: string; major: string }[]>('fbclient_list_releases')
      .then(setFbclientReleases)
      .catch(() => setFbclientReleases(null));
  }, []);

  const refreshProfiles = useCallback(async () => {
    try {
      const list = await tauriTransport.invoke<Profile[]>('profile_list');
      setProfiles(list);
    } catch (err) {
      patchTab(activeTabId, { error: String(err) });
    }
  }, [activeTabId, patchTab]);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  const updateField = <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]) => {
    patchTab(activeTabId, {
      form: { ...activeTab.form, [key]: value },
      testResult: null,
    });
  };

  const handleSelectProfile = (id: string | null) => {
    if (id === null) {
      patchTab(activeTabId, { selectedProfileId: null, profileName: '', profileColor: null });
      return;
    }
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;
    patchTab(activeTabId, {
      selectedProfileId: id,
      profileName: profile.name,
      profileColor: profile.color ?? null,
      form: {
        host: profile.host,
        port: profile.port,
        database: profile.database,
        user: profile.user,
        password: '',
        pureRust: profile.pureRust,
        encryptionKey: '',
        encryptionRequired: profile.encryptionRequired,
        fbclientPath: profile.fbclientPath ?? '',
        charset: profile.charset ?? 'UTF8',
      },
    });
  };

  const handleSaveProfile = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    patchTab(tabId, { error: null, busy: true });
    try {
      const draft = {
        id: tab.selectedProfileId,
        name: tab.profileName.trim(),
        host: tab.form.host,
        port: tab.form.port,
        database: tab.form.database,
        user: tab.form.user,
        encryptionRequired: tab.form.encryptionRequired,
        pureRust: tab.form.pureRust,
        password: tab.form.password === '' ? null : tab.form.password,
        encryptionKey: tab.form.encryptionKey === '' ? null : tab.form.encryptionKey,
        color: tab.profileColor,
        fbclientPath: tab.form.fbclientPath === '' ? null : tab.form.fbclientPath,
        charset: tab.form.charset === '' ? null : tab.form.charset,
      };
      const saved = await tauriTransport.invoke<Profile>('profile_save', { draft });
      await refreshProfiles();
      patchTab(tabId, {
        selectedProfileId: saved.id,
        profileName: saved.name,
        profileColor: saved.color ?? null,
      });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleDeleteProfile = async (id: string) => {
    const tabId = activeTabId;
    const existing = profiles.find((p) => p.id === id);
    if (!existing) return;
    if (!window.confirm(`Delete "${existing.name}"? This also removes its keyring entries.`)) {
      return;
    }
    patchTab(tabId, { error: null, busy: true });
    try {
      await tauriTransport.invoke<null>('profile_delete', { id });
      await refreshProfiles();
      if (activeTab.selectedProfileId === id) {
        patchTab(tabId, { selectedProfileId: null, profileName: '' });
      }
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleQuickConnect = async (profileId: string) => {
    const tabId = activeTabId;
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;
    patchTab(tabId, {
      error: null,
      busy: true,
      cryptState: null,
      selectedProfileId: profileId,
      profileName: profile.name,
      form: {
        ...activeTab.form,
        host: profile.host,
        port: profile.port,
        database: profile.database,
        user: profile.user,
        encryptionRequired: profile.encryptionRequired,
        pureRust: profile.pureRust,
      },
    });
    try {
      const response = await tauriTransport.invoke<ConnectResponse>('profile_connect', {
        request: {
          profileId,
          password: activeTab.form.password === '' ? null : activeTab.form.password,
          encryptionKey: activeTab.form.encryptionKey === '' ? null : activeTab.form.encryptionKey,
          pureRust: profile.pureRust,
          encryptionRequired: profile.encryptionRequired,
          fbclientPath:
            activeTab.form.fbclientPath === '' ? null : activeTab.form.fbclientPath,
        },
      });
      patchTab(tabId, {
        sessionId: response.sessionId,
        results: null,
        health: 'healthy',
        lastPingAt: Date.now(),
        connectedAt: Date.now(),
      });
      renameTab(tabId, profile.name);
      void refreshCryptState(tabId, response.sessionId);
      void refreshSchema(tabId, response.sessionId);
      void refreshEngineVersion(tabId, response.sessionId);
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleTestConnection = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    patchTab(tabId, { testing: true, testResult: null });
    try {
      const res = await tauriTransport.invoke<TestConnectionResult>('db_test_connection', {
        request: {
          host: tab.form.host,
          port: tab.form.port,
          database: tab.form.database,
          user: tab.form.user,
          password: tab.form.password,
          encryptionKey: tab.form.encryptionKey === '' ? null : tab.form.encryptionKey,
          encryptionRequired: tab.form.encryptionRequired,
          pureRust: tab.form.pureRust,
          fbclientPath: tab.form.fbclientPath === '' ? null : tab.form.fbclientPath,
          charset: tab.form.charset === '' ? null : tab.form.charset,
        },
      });
      patchTab(tabId, { testResult: res });
    } catch (err) {
      patchTab(tabId, {
        testResult: {
          ok: false,
          firebirdVersion: null,
          error: String(err),
          durationMs: 0,
        },
      });
    } finally {
      patchTab(tabId, { testing: false });
    }
  };

  const handleConnect = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    patchTab(tabId, { error: null, busy: true, cryptState: null });
    try {
      let response: ConnectResponse;
      if (tab.selectedProfileId !== null) {
        response = await tauriTransport.invoke<ConnectResponse>('profile_connect', {
          request: {
            profileId: tab.selectedProfileId,
            password: tab.form.password === '' ? null : tab.form.password,
            encryptionKey: tab.form.encryptionKey === '' ? null : tab.form.encryptionKey,
            pureRust: tab.form.pureRust,
            encryptionRequired: tab.form.encryptionRequired,
            fbclientPath: tab.form.fbclientPath === '' ? null : tab.form.fbclientPath,
            charset: tab.form.charset === '' ? null : tab.form.charset,
          },
        });
      } else {
        response = await tauriTransport.invoke<ConnectResponse>('db_connect', {
          request: {
            host: tab.form.host,
            port: tab.form.port,
            database: tab.form.database,
            user: tab.form.user,
            password: tab.form.password,
            encryptionKey: tab.form.encryptionKey === '' ? null : tab.form.encryptionKey,
            encryptionRequired: tab.form.encryptionRequired,
            pureRust: tab.form.pureRust,
            fbclientPath: tab.form.fbclientPath === '' ? null : tab.form.fbclientPath,
            charset: tab.form.charset === '' ? null : tab.form.charset,
          },
        });
      }
      patchTab(tabId, {
        sessionId: response.sessionId,
        results: null,
        health: 'healthy',
        lastPingAt: Date.now(),
        connectedAt: Date.now(),
      });
      renameTab(tabId, tab.profileName.trim() || deriveTitle(tab.form));
      void refreshCryptState(tabId, response.sessionId);
      void refreshSchema(tabId, response.sessionId);
      void refreshEngineVersion(tabId, response.sessionId);
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleReconnect = useCallback(async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (tab.health === 'reconnecting') return;
    patchTab(tabId, { health: 'reconnecting', error: null });
    try {
      let response: ConnectResponse;
      if (tab.selectedProfileId !== null) {
        response = await tauriTransport.invoke<ConnectResponse>('profile_connect', {
          request: {
            profileId: tab.selectedProfileId,
            password: tab.form.password === '' ? null : tab.form.password,
            encryptionKey: tab.form.encryptionKey === '' ? null : tab.form.encryptionKey,
            pureRust: tab.form.pureRust,
            encryptionRequired: tab.form.encryptionRequired,
            fbclientPath: tab.form.fbclientPath === '' ? null : tab.form.fbclientPath,
            charset: tab.form.charset === '' ? null : tab.form.charset,
          },
        });
      } else {
        response = await tauriTransport.invoke<ConnectResponse>('db_connect', {
          request: {
            host: tab.form.host,
            port: tab.form.port,
            database: tab.form.database,
            user: tab.form.user,
            password: tab.form.password,
            encryptionKey: tab.form.encryptionKey === '' ? null : tab.form.encryptionKey,
            encryptionRequired: tab.form.encryptionRequired,
            pureRust: tab.form.pureRust,
            fbclientPath: tab.form.fbclientPath === '' ? null : tab.form.fbclientPath,
            charset: tab.form.charset === '' ? null : tab.form.charset,
          },
        });
      }
      patchTab(tabId, {
        sessionId: response.sessionId,
        health: 'healthy',
        lastPingAt: Date.now(),
        connectedAt: Date.now(),
      });
      void tauriTransport
        .invoke<string>('db_ping', { sessionId: response.sessionId })
        .then((version) =>
          patchTab(tabId, {
            engineVersion: version.trim().length > 0 ? version.trim() : null,
          }),
        )
        .catch(() => patchTab(tabId, { engineVersion: null }));
    } catch (err) {
      patchTab(tabId, { health: 'dead', error: String(err) });
    }
  }, [activeTab, activeTabId, patchTab]);

  useHealthProbe({
    tabs,
    ping: (sessionId) => tauriTransport.invoke<string>('db_ping', { sessionId }),
    onPatch: (tabId, patch) => patchTab(tabId, patch),
  });

  // Auto-reconnect: when a tab's health probe trips to `dead`, fire a
  // single reconnect attempt automatically. `lastAutoDeadRef` gates
  // retries to one per dead transition per tab so a failing attach
  // does not loop. Manual reconnect always clears the gate the next
  // time the tab returns to healthy.
  const autoReconnect = useConnectionPrefs((s) => s.autoReconnect);
  const lastAutoDeadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoReconnect) {
      lastAutoDeadRef.current = null;
      return;
    }
    if (activeTab.health !== 'dead') {
      lastAutoDeadRef.current = null;
      return;
    }
    if (activeTab.busy) return;
    if (lastAutoDeadRef.current === activeTab.id) return;
    lastAutoDeadRef.current = activeTab.id;
    void handleReconnect();
  }, [activeTab.health, activeTab.busy, activeTab.id, autoReconnect, handleReconnect]);

  const refreshCryptState = async (tabId: string, sessionId: string) => {
    try {
      const state = await tauriTransport.invoke<CryptState>('db_crypt_state', { sessionId });
      patchTab(tabId, { cryptState: state });
    } catch {
      patchTab(tabId, { cryptState: null });
    }
  };

  const refreshEngineVersion = async (tabId: string, sessionId: string) => {
    try {
      const version = await tauriTransport.invoke<string>('db_ping', { sessionId });
      patchTab(tabId, {
        engineVersion: version.trim().length > 0 ? version.trim() : null,
        lastPingAt: Date.now(),
      });
    } catch {
      patchTab(tabId, { engineVersion: null });
    }
  };

  const refreshSchema = async (tabId: string, sessionId: string) => {
    try {
      const schema = await tauriTransport.invoke<Schema>('db_describe_schema', { sessionId });
      patchTab(tabId, { schema });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    }
  };

  const handleExecute = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (!tab.sessionId) return;
    const sqlAtSend = tab.sql;
    const key = recentKeyOf(tab.form, tab.profileName);
    const startedAt = Date.now();
    patchTab(tabId, { error: null, busy: true });
    try {
      const res = await tauriTransport.invoke<StatementOutcome[]>('db_execute', {
        request: {
          sessionId: tab.sessionId,
          sql: sqlAtSend,
          profileId: tab.selectedProfileId,
          historyLimit: currentHistoryLimit(),
        },
      });
      patchTab(tabId, { results: res, executedSql: sqlAtSend, focusedObjectName: null });
      notifyMutations(res);
      recordExec(key, sqlAtSend, startedAt, res, null);
    } catch (err) {
      patchTab(tabId, { error: String(err) });
      recordExec(key, sqlAtSend, startedAt, null, String(err));
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleCommitCellEdit = useCallback(
    async (sql: string) => {
      const tab = activeTab;
      if (!tab.sessionId) {
        throw new Error('No active session.');
      }
      const key = recentKeyOf(tab.form, tab.profileName);
      const startedAt = Date.now();
      try {
        const outcomes = await tauriTransport.invoke<StatementOutcome[]>('db_execute', {
          request: {
            sessionId: tab.sessionId,
            sql,
            profileId: tab.selectedProfileId,
            historyLimit: currentHistoryLimit(),
          },
        });
        const first = outcomes[0];
        if (!first) {
          throw new Error('UPDATE produced no outcome.');
        }
        if (first.status === 'err') {
          throw new Error(first.error);
        }
        if ('Affected' in first.result && first.result.Affected.rows === 0) {
          throw new Error('UPDATE matched zero rows.');
        }
        notifyMutations(outcomes);
        recordExec(key, sql, startedAt, outcomes, null);
      } catch (err) {
        recordExec(key, sql, startedAt, null, String(err));
        throw err;
      }
    },
    [activeTab],
  );

  const handleFetchBlob = useCallback(
    async (blobId: string) => {
      const tab = activeTab;
      if (!tab.sessionId) throw new Error('No active session.');
      return await tauriTransport.invoke<string>('db_fetch_blob', {
        sessionId: tab.sessionId,
        blobId,
      });
    },
    [activeTab],
  );

  const handleExecuteDdl = useCallback(
    async (sql: string) => {
      const tab = activeTab;
      if (!tab.sessionId) throw new Error('No active session.');
      const key = recentKeyOf(tab.form, tab.profileName);
      const startedAt = Date.now();
      try {
        const outcomes = await tauriTransport.invoke<StatementOutcome[]>(
          'db_execute',
          {
            request: {
              sessionId: tab.sessionId,
              sql,
              profileId: tab.selectedProfileId,
              historyLimit: currentHistoryLimit(),
            },
          },
        );
        for (const outcome of outcomes) {
          if (outcome.status === 'err') throw new Error(outcome.error);
        }
        notifyMutations(outcomes);
        recordExec(key, sql, startedAt, outcomes, null);
      } catch (err) {
        recordExec(key, sql, startedAt, null, String(err));
        throw err;
      }
    },
    [activeTab],
  );

  const handleStreamedExport: StreamedExportRunner = useCallback(
    async (req: StreamedExportRequest): Promise<StreamedExportResult> => {
      const { listen } = await import('@tauri-apps/api/event');
      const chunks: string[] = [];
      let resolveDone: (() => void) | null = null;
      let rejectErr: ((err: Error) => void) | null = null;
      const completion = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectErr = reject;
      });
      let expectedId: string | null = null;
      const unsubs: (() => void)[] = [];
      unsubs.push(
        await listen<{ exportId: string; seq: number; text: string }>(
          'export:chunk',
          (event) => {
            if (expectedId === null || event.payload.exportId === expectedId) {
              chunks[event.payload.seq] = event.payload.text;
            }
          },
        ),
      );
      unsubs.push(
        await listen<{ exportId: string; totalBytes: number }>(
          'export:done',
          (event) => {
            if (expectedId === null || event.payload.exportId === expectedId) {
              resolveDone?.();
            }
          },
        ),
      );
      unsubs.push(
        await listen<{ exportId: string; error: string }>('export:err', (event) => {
          if (expectedId === null || event.payload.exportId === expectedId) {
            rejectErr?.(new Error(event.payload.error));
          }
        }),
      );
      try {
        const csvDelimiter = req.csvDelimiter;
        expectedId = await tauriTransport.invoke<string>('db_export', {
          request: {
            sessionId: req.sessionId,
            format: req.format,
            csvDelimiter,
            scope: req.scope,
            includeDdl: req.includeDdl ?? true,
          },
        });
        await completion;
        const body = chunks.join('');
        const mime: Record<string, string> = {
          csv: 'text/csv',
          json: 'application/json',
          sql: 'application/sql',
          xml: 'application/xml',
        };
        const blob = new Blob([body], {
          type: `${mime[req.format] ?? 'application/octet-stream'};charset=utf-8`,
        });
        const stamp = new Date()
          .toISOString()
          .replace(/[-:T]/g, '')
          .slice(0, 15);
        return {
          blob,
          suggestedFilename: `plamenix-export-${stamp}.${req.format}`,
        };
      } finally {
        for (const u of unsubs) u();
      }
    },
    [],
  );

  const handleFetchTableExport = useCallback(
    async (table: TableInfo): Promise<TableExportPart> => {
      const tab = activeTab;
      if (!tab.sessionId) throw new Error('No active session.');
      const quoted = /^[A-Z_][A-Z0-9_]*$/.test(table.name)
        ? table.name
        : `"${table.name.replace(/"/g, '""')}"`;
      const outcomes = await tauriTransport.invoke<StatementOutcome[]>(
        'db_execute',
        {
          request: {
            sessionId: tab.sessionId,
            sql: `SELECT * FROM ${quoted}`,
            profileId: tab.selectedProfileId,
            historyLimit: currentHistoryLimit(),
          },
        },
      );
      const first = outcomes[0];
      if (!first) throw new Error(`No outcome for ${table.name}.`);
      if (first.status === 'err') throw new Error(`${table.name}: ${first.error}`);
      if (!('Rows' in first.result)) {
        throw new Error(`${table.name}: SELECT did not return rows.`);
      }
      return {
        table,
        columns: first.result.Rows.columns,
        rows: first.result.Rows.rows,
      };
    },
    [activeTab],
  );

  const handleCountAllRows = useCallback(
    async ({ table, predicate }: { table: string; predicate: string | null }) => {
      const tab = activeTab;
      if (!tab.sessionId) throw new Error('No active session.');
      // `quoteIdentBare` keeps existing all-upper identifiers bare (the
      // Firebird-friendly form) and quotes lowercase/mixed names.
      const quoted = /^[A-Z_][A-Z0-9_]*$/.test(table)
        ? table
        : `"${table.replace(/"/g, '""')}"`;
      const sql = predicate
        ? `SELECT COUNT(*) FROM ${quoted} WHERE ${predicate}`
        : `SELECT COUNT(*) FROM ${quoted}`;
      const outcomes = await tauriTransport.invoke<StatementOutcome[]>(
        'db_execute',
        {
          request: {
            sessionId: tab.sessionId,
            sql,
            profileId: tab.selectedProfileId,
            historyLimit: currentHistoryLimit(),
          },
        },
      );
      const first = outcomes[0];
      if (!first || first.status !== 'ok' || !('Rows' in first.result)) {
        throw new Error('COUNT(*) did not return a row.');
      }
      const cell = first.result.Rows.rows[0]?.cells[0];
      if (!cell) throw new Error('COUNT(*) returned an empty row.');
      if (cell.type === 'integer') return cell.value;
      if (cell.type === 'float' && typeof cell.value === 'number') {
        return cell.value;
      }
      throw new Error(`COUNT(*) returned an unexpected cell type: ${cell.type}.`);
    },
    [activeTab],
  );

  const handleFetchScopedRows = useCallback(
    async ({ table, predicate }: { table: string; predicate: string | null }) => {
      const tab = activeTab;
      if (!tab.sessionId) throw new Error('No active session.');
      const quoted = /^[A-Z_][A-Z0-9_]*$/.test(table)
        ? table
        : `"${table.replace(/"/g, '""')}"`;
      const sql = predicate
        ? `SELECT * FROM ${quoted} WHERE ${predicate}`
        : `SELECT * FROM ${quoted}`;
      const outcomes = await tauriTransport.invoke<StatementOutcome[]>('db_execute', {
        request: {
          sessionId: tab.sessionId,
          sql,
          profileId: null,
        },
      });
      const first = outcomes[0];
      if (!first) throw new Error('Scoped fetch produced no outcome.');
      if (first.status === 'err') throw new Error(first.error);
      if (!('Rows' in first.result)) {
        throw new Error('Scoped fetch did not return rows.');
      }
      return first.result.Rows.rows;
    },
    [activeTab],
  );

  const handleBrowseTable = useCallback(
    async (name: string) => {
      const tabId = activeTabId;
      const tab = activeTab;
      if (!tab.sessionId) return;
      const quoted = /^[A-Z_][A-Z0-9_]*$/.test(name)
        ? name
        : `"${name.replace(/"/g, '""')}"`;
      const sql = `SELECT * FROM ${quoted}`;
      const key = recentKeyOf(tab.form, tab.profileName);
      const startedAt = Date.now();
      patchTab(tabId, { error: null, busy: true });
      try {
        const res = await tauriTransport.invoke<StatementOutcome[]>('db_execute', {
          request: {
            sessionId: tab.sessionId,
            sql,
            profileId: tab.selectedProfileId,
            historyLimit: currentHistoryLimit(),
          },
        });
        // Show the data in the result panel without touching the editor
        // buffer so any user-in-progress SQL stays intact. Also flag
        // the tab as table-focused so the content pane swaps to the
        // tabbed `TableObjectView` (Data / Schema / DDL).
        patchTab(tabId, { results: res, executedSql: sql, focusedObjectName: name });
        recordExec(key, sql, startedAt, res, null);
      } catch (err) {
        patchTab(tabId, { error: String(err) });
        recordExec(key, sql, startedAt, null, String(err));
      } finally {
        patchTab(tabId, { busy: false });
      }
    },
    [activeTab, activeTabId, patchTab],
  );

  const handleApplyFilter = useCallback(
    async (sql: string) => {
      const tabId = activeTabId;
      const tab = activeTab;
      if (!tab.sessionId) return;
      const key = recentKeyOf(tab.form, tab.profileName);
      const startedAt = Date.now();
      patchTab(tabId, { error: null, busy: true });
      try {
        const res = await tauriTransport.invoke<StatementOutcome[]>('db_execute', {
          request: {
            sessionId: tab.sessionId,
            sql,
            profileId: tab.selectedProfileId,
            historyLimit: currentHistoryLimit(),
          },
        });
        patchTab(tabId, { results: res, executedSql: sql });
        recordExec(key, sql, startedAt, res, null);
      } catch (err) {
        patchTab(tabId, { error: String(err) });
        recordExec(key, sql, startedAt, null, String(err));
      } finally {
        patchTab(tabId, { busy: false });
      }
    },
    [activeTab, activeTabId, patchTab],
  );

  const handleSchemaAction = async (action: SchemaAction) => {
    const tabId = activeTabId;
    const tab = activeTab;
    const ddl = schemaDdl(action);
    if (ddl.autoExecute) {
      if (!tab.sessionId) return;
      const key = recentKeyOf(tab.form, tab.profileName);
      const startedAt = Date.now();
      patchTab(tabId, { error: null, busy: true });
      try {
        const res = await tauriTransport.invoke<StatementOutcome[]>('db_execute', {
          request: {
            sessionId: tab.sessionId,
            sql: ddl.sql,
            profileId: tab.selectedProfileId,
            historyLimit: currentHistoryLimit(),
          },
        });
        notifyMutations(res);
        recordExec(key, ddl.sql, startedAt, res, null);
        void refreshSchema(tabId, tab.sessionId);
      } catch (err) {
        patchTab(tabId, { error: String(err) });
        recordExec(key, ddl.sql, startedAt, null, String(err));
      } finally {
        patchTab(tabId, { busy: false });
      }
      return;
    }
    if (!ddl.destructive) {
      patchTab(tabId, { sql: ddl.sql });
      return;
    }
    if (!window.confirm(ddl.confirmPrompt ?? 'Run destructive statement?')) return;
    if (!tab.sessionId) return;
    const key = recentKeyOf(tab.form, tab.profileName);
    const startedAt = Date.now();
    patchTab(tabId, { error: null, busy: true, sql: ddl.sql });
    try {
      const res = await tauriTransport.invoke<StatementOutcome[]>('db_execute', {
        request: {
          sessionId: tab.sessionId,
          sql: ddl.sql,
          profileId: tab.selectedProfileId,
          historyLimit: currentHistoryLimit(),
        },
      });
      patchTab(tabId, { results: res });
      notifyMutations(res);
      recordExec(key, ddl.sql, startedAt, res, null);
      void refreshSchema(tabId, tab.sessionId);
    } catch (err) {
      patchTab(tabId, { error: String(err) });
      recordExec(key, ddl.sql, startedAt, null, String(err));
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleDisconnect = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (!tab.sessionId) return;
    patchTab(tabId, { error: null, busy: true });
    try {
      await tauriTransport.invoke<null>('db_close', { sessionId: tab.sessionId });
      if (tab.selectedProfileId !== null) {
        // Best-effort; do not block disconnect on a touch failure.
        void tauriTransport
          .invoke<void>('profile_touch_disconnected', { id: tab.selectedProfileId })
          .catch(() => {});
      }
      patchTab(tabId, {
        sessionId: null,
        results: null,
        cryptState: null,
        schema: null,
        health: 'unknown',
        lastPingAt: null,
        connectedAt: null,
        engineVersion: null,
      });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleTabClose = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab?.sessionId) {
      void tauriTransport
        .invoke<null>('db_close', { sessionId: tab.sessionId })
        .catch(() => {});
    }
    closeTab(id);
  };

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const toggleMode = useThemeStore((s) => s.toggleMode);
  const toggleSidebar = useThemeStore((s) => s.toggleSidebar);
  const themeMode = useResolvedThemeMode();

  const handlersRef = useRef({
    newTab,
    handleTabClose,
    handleSaveProfile,
    handleConnect,
    handleExecute,
    handleDisconnect,
    refreshSchema,
    toggleMode,
    toggleSidebar,
    setPaletteOpen,
    setSearchOpen,
    setShortcutsOpen,
    activeTab,
    activeTabId,
  });
  handlersRef.current = {
    newTab,
    handleTabClose,
    handleSaveProfile,
    handleConnect,
    handleExecute,
    handleDisconnect,
    refreshSchema,
    toggleMode,
    toggleSidebar,
    setPaletteOpen,
    setSearchOpen,
    setShortcutsOpen,
    activeTab,
    activeTabId,
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const h = handlersRef.current;
      // `?` opens the cheat sheet only when the user isn't typing —
      // questions marks inside SQL or text inputs must reach the
      // editor / form, not the modal.
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        h.setShortcutsOpen(true);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey && key === 'f') {
        e.preventDefault();
        h.setSearchOpen(true);
        return;
      }
      switch (key) {
        case 'k':
          e.preventDefault();
          h.setPaletteOpen(true);
          break;
        case 't':
          e.preventDefault();
          h.newTab();
          break;
        case 'w':
          e.preventDefault();
          h.handleTabClose(h.activeTabId);
          break;
        case 's':
          if (
            h.activeTab.sessionId === null &&
            h.activeTab.profileName.trim() !== '' &&
            !h.activeTab.busy
          ) {
            e.preventDefault();
            void h.handleSaveProfile();
          }
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const mod = getModKeyLabel();

  const accentByTabId = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const t of tabs) {
      const color = t.profileColor ?? null;
      const swatch = swatchFor(color, themeMode);
      if (swatch !== undefined) map[t.id] = swatch;
    }
    return map;
  }, [tabs, themeMode]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'new-tab',
        label: 'New tab',
        description: 'Open a fresh disconnected session',
        icon: Plus,
        shortcut: `${mod}T`,
        group: 'Tabs',
        run: () => newTab(),
      },
      {
        id: 'close-tab',
        label: 'Close tab',
        description: 'Close the active session and tab',
        icon: X,
        shortcut: `${mod}W`,
        group: 'Tabs',
        run: () => handleTabClose(activeTabId),
      },
      {
        id: 'toggle-theme',
        label: `Switch to ${themeMode === 'dark' ? 'light' : 'dark'} theme`,
        description: 'Flip the Plamenix theme',
        icon: themeMode === 'dark' ? Sun : Moon,
        group: 'Appearance',
        run: () => toggleMode(),
      },
      {
        id: 'toggle-sidebar',
        label: 'Toggle schema sidebar',
        description: 'Collapse or expand the schema browser',
        icon: PanelLeftClose,
        group: 'Appearance',
        run: () => toggleSidebar(),
      },
      {
        id: 'show-shortcuts',
        label: 'Show keyboard shortcuts',
        description: 'Cheat sheet of every shortcut Plamenix exposes',
        icon: Keyboard,
        shortcut: '?',
        group: 'Help',
        run: () => setShortcutsOpen(true),
      },
    ];

    if (activeTab.sessionId === null) {
      list.push(
        {
          id: 'save-profile',
          label: 'Save connection profile',
          description: 'Persist the current form values',
          icon: Save,
          shortcut: `${mod}S`,
          group: 'Connection',
          run: () => void handleSaveProfile(),
        },
        {
          id: 'connect',
          label: 'Connect',
          description: 'Open a session against the current form',
          icon: Plug,
          shortcut: `${mod}↵`,
          group: 'Connection',
          run: () => void handleConnect(),
        },
      );
    } else {
      list.push(
        {
          id: 'execute',
          label: 'Execute SQL',
          description: 'Run the current editor buffer',
          icon: Play,
          shortcut: `${mod}↵`,
          group: 'Session',
          run: () => void handleExecute(),
        },
        {
          id: 'refresh-schema',
          label: 'Refresh schema',
          description: 'Reload the table / view list',
          icon: RefreshCw,
          group: 'Session',
          run: () => {
            if (activeTab.sessionId) {
              void refreshSchema(activeTabId, activeTab.sessionId);
            }
          },
        },
        {
          id: 'disconnect',
          label: 'Disconnect',
          description: 'Close the active session',
          icon: LogOut,
          group: 'Session',
          run: () => void handleDisconnect(),
        },
      );
      if (activeTab.selectedProfileId !== null) {
        list.push({
          id: 'history',
          label: 'Show query history',
          description: 'Browse and replay statements run under this profile',
          icon: History,
          group: 'Session',
          run: () => void openHistory(),
        });
      }
    }
    return list;
  }, [
    activeTab,
    activeTabId,
    handleConnect,
    handleDisconnect,
    handleExecute,
    handleSaveProfile,
    handleTabClose,
    mod,
    newTab,
    openHistory,
    themeMode,
    toggleMode,
    toggleSidebar,
  ]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-stretch bg-inset">
        <div className="flex-1 overflow-hidden">
          <TabStrip
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActive}
            onClose={handleTabClose}
            onNew={() => newTab()}
            onReorder={reorderTab}
            accentByTabId={accentByTabId}
          />
        </div>
        <div className="flex shrink-0 items-stretch border-b border-edge">
          <SettingsButton onOpenDetailed={() => setShowSettings(true)} />
        </div>
      </div>
      {showSettings && activeTab.sessionId === null ? (
        <SettingsPage
          onClose={() => setShowSettings(false)}
          backLabel="Back to connections"
        />
      ) : activeTab.sessionId === null ? (
        <ConnectView
          tab={activeTab}
          profiles={profiles}
          onFieldChange={updateField}
          onSelectProfile={handleSelectProfile}
          onProfileNameChange={(v) => patchTab(activeTabId, { profileName: v })}
          onProfileColorChange={(c) => patchTab(activeTabId, { profileColor: c })}
          onSaveProfile={handleSaveProfile}
          onDeleteProfile={handleDeleteProfile}
          onQuickConnect={handleQuickConnect}
          onConnect={handleConnect}
          onTest={handleTestConnection}
          aliasesData={aliasesData}
          aliasesLoading={aliasesLoading}
          onListAliases={handleListAliases}
          onBrowseFbclient={handleBrowseFbclient}
          onBrowseFbclientDir={handleBrowseFbclientDir}
          onDownloadFbclient={handleDownloadFbclient}
          fbclientReleases={fbclientReleases}
        />
      ) : (
        <SessionView
          tab={activeTab}
          showSettings={showSettings}
          onCloseSettings={() => setShowSettings(false)}
          onCloseFocusedObject={() => patchTab(activeTabId, { focusedObjectName: null })}
          onOpenDeepSearch={() => setSearchOpen(true)}
          onSqlChange={(v) => patchTab(activeTabId, { sql: v })}
          onBookmarksChange={(next) => patchTab(activeTabId, { bookmarks: next })}
          onExecute={handleExecute}
          onDisconnect={handleDisconnect}
          onOpenStats={openStats}
          onCommitCellEdit={handleCommitCellEdit}
          onCommitDdl={handleExecuteDdl}
          onFetchTableExport={handleFetchTableExport}
          onStreamedExport={handleStreamedExport}
          onApplyFilter={handleApplyFilter}
          onColumnWidthsChange={(next) => patchTab(activeTabId, { columnWidths: next })}
          onFetchBlob={handleFetchBlob}
          onCountAllRows={handleCountAllRows}
          onFetchScopedRows={handleFetchScopedRows}
          onReconnect={handleReconnect}
          onRefreshSchema={() => {
            if (activeTab.sessionId) {
              void refreshSchema(activeTabId, activeTab.sessionId);
            }
          }}
          onSchemaAction={handleSchemaAction}
          onClearError={() => patchTab(activeTabId, { error: null })}
          plugins={plugins}
          onPickPluginPanel={(plugin, panel) => setOpenPluginPanel({ plugin, panel })}
          onShowDdl={handleShowDdl}
          onBrowseTable={handleBrowseTable}
        />
      )}
      <DdlViewerModal
        kind={ddlViewer?.kind ?? null}
        name={ddlViewer?.name ?? null}
        source={ddlViewer?.source ?? null}
        loading={ddlViewer?.loading ?? false}
        error={ddlViewer?.error ?? null}
        onClose={() => setDdlViewer(null)}
        onOpenInEditor={(sql) => {
          const id = newTab();
          patchTab(id, { sql });
          setActive(id);
        }}
      />
      <StatusBar
        sessionId={activeTab.sessionId}
        health={activeTab.health}
        user={activeTab.form.user}
        host={activeTab.form.host}
        port={activeTab.form.port}
        database={activeTab.form.database}
        executedSql={activeTab.executedSql}
        results={activeTab.results}
        recentKey={recentKeyOf(activeTab.form, activeTab.profileName)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
      <ShortcutsCheatSheet
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      <SearchPalette
        open={searchOpen}
        schema={activeTab.schema}
        onClose={() => setSearchOpen(false)}
        onPick={(id) =>
          patchTab(activeTabId, {
            sql:
              activeTab.sql.length > 0 && !activeTab.sql.endsWith(' ')
                ? `${activeTab.sql} ${id}`
                : `${activeTab.sql}${id}`,
          })
        }
      />
      <HistoryPanel
        open={historyOpen}
        profileLabel={
          (activeTab.selectedProfileId
            ? profiles.find((p) => p.id === activeTab.selectedProfileId)?.name
            : null) ?? activeTab.profileName ?? 'No profile'
        }
        entries={historyEntries}
        loading={historyLoading}
        onClose={() => setHistoryOpen(false)}
        onPick={(sql) => patchTab(activeTabId, { sql })}
        onClear={clearHistory}
        onSetLabel={setHistoryLabel}
        onDeleteEntry={deleteHistoryEntry}
        onDeleteEntries={deleteHistoryEntries}
      />
      <StatsDashboard
        open={statsOpen}
        stats={stats}
        loading={statsLoading}
        error={statsError}
        lastRefreshLabel={
          statsFetchedAt !== null ? formatRelative(statsFetchedAt, statsTick) : null
        }
        onClose={() => setStatsOpen(false)}
        onRefresh={() => {
          if (activeTab.sessionId) void refreshStats(activeTab.sessionId);
        }}
      />
      <PluginPanelModal
        plugin={openPluginPanel?.plugin ?? null}
        panel={openPluginPanel?.panel ?? null}
        onClose={() => setOpenPluginPanel(null)}
        onGrant={handleGrantPermission}
        onRevoke={handleRevokePermission}
      />
      <ToastViewport
        onOpenInEditor={(sql) => {
          const id = newTab();
          patchTab(id, { sql });
          setActive(id);
        }}
      />
    </div>
  );
}

interface ConnectViewProps {
  tab: TabState;
  profiles: Profile[];
  onFieldChange: <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]) => void;
  onSelectProfile: (id: string | null) => void;
  onProfileNameChange: (value: string) => void;
  onProfileColorChange: (color: string | null) => void;
  onSaveProfile: () => void;
  onDeleteProfile: (id: string) => void;
  onQuickConnect: (id: string) => void;
  onConnect: () => void;
  onTest: () => void;
  aliasesData: ListAliasesResult | null;
  aliasesLoading: boolean;
  onListAliases: () => void;
  onBrowseFbclient: () => Promise<string | null>;
  onBrowseFbclientDir: () => Promise<{
    fbclientPath: string | null;
    hasFbcrypt: boolean;
    hasOpenssl: boolean;
  } | null>;
  onDownloadFbclient: (version?: string) => Promise<string>;
  fbclientReleases: { version: string }[] | null;
}

function ConnectView({
  tab,
  profiles,
  onFieldChange,
  onSelectProfile,
  onProfileNameChange,
  onProfileColorChange,
  onSaveProfile,
  onDeleteProfile,
  onQuickConnect,
  onConnect,
  onTest,
  aliasesData,
  aliasesLoading,
  onListAliases,
  onBrowseFbclient,
  onBrowseFbclientDir,
  onDownloadFbclient,
  fbclientReleases,
}: ConnectViewProps) {
  const selected = tab.selectedProfileId
    ? profiles.find((p) => p.id === tab.selectedProfileId)
    : undefined;
  const passwordHint =
    selected?.passwordKeyringRef !== undefined
      ? 'Leave empty to use the password stored in your keyring for this profile.'
      : undefined;
  return (
    <div className="flex-1 overflow-hidden">
      <ConnectionScreen
        form={tab.form}
        profileName={tab.profileName}
        busy={tab.busy}
        error={tab.error}
        profiles={profiles}
        selectedProfileId={tab.selectedProfileId}
        testing={tab.testing}
        testResult={tab.testResult}
        {...(passwordHint !== undefined && { passwordHint })}
        profileColor={tab.profileColor}
        onChange={onFieldChange}
        onProfileNameChange={onProfileNameChange}
        onProfileColorChange={onProfileColorChange}
        onSelectProfile={onSelectProfile}
        onSaveProfile={onSaveProfile}
        onDeleteProfile={onDeleteProfile}
        onQuickConnect={onQuickConnect}
        onSubmit={onConnect}
        onTest={onTest}
        aliasesData={aliasesData}
        aliasesLoading={aliasesLoading}
        onListAliases={onListAliases}
        onBrowseFbclient={onBrowseFbclient}
        onBrowseFbclientDir={onBrowseFbclientDir}
        onDownloadFbclient={onDownloadFbclient}
        fbclientReleases={fbclientReleases}
      />
    </div>
  );
}

interface SessionViewProps {
  tab: TabState;
  onSqlChange: (value: string) => void;
  onBookmarksChange: (next: Record<string, number>) => void;
  onExecute: () => void;
  onDisconnect: () => void;
  onRefreshSchema: () => void;
  onSchemaAction: (action: SchemaAction) => void;
  onClearError: () => void;
  onOpenStats: () => void;
  onCommitCellEdit: (sql: string) => Promise<void>;
  onCommitDdl: (sql: string) => Promise<void>;
  onFetchTableExport: (table: TableInfo) => Promise<TableExportPart>;
  onStreamedExport: StreamedExportRunner;
  onApplyFilter: (sql: string) => Promise<void>;
  onColumnWidthsChange: (next: Record<string, number>) => void;
  onFetchBlob: (blobId: string) => Promise<string>;
  onCountAllRows: (args: { table: string; predicate: string | null }) => Promise<number>;
  onFetchScopedRows: (args: { table: string; predicate: string | null }) => Promise<
    { cells: ColumnValue[] }[]
  >;
  onReconnect: () => void;
  plugins: ActivePlugin[];
  onPickPluginPanel: (plugin: ActivePlugin, panel: SidebarPanelInfo) => void;
  onShowDdl: (kind: DdlSourceKind, name: string) => void;
  onBrowseTable: (name: string) => Promise<void>;
  onCloseFocusedObject: () => void;
  showSettings: boolean;
  onCloseSettings: () => void;
  onOpenDeepSearch: () => void;
}

function SessionView({
  tab,
  onSqlChange,
  onBookmarksChange,
  onExecute,
  onDisconnect,
  onRefreshSchema,
  onSchemaAction,
  onClearError,
  onOpenStats,
  onCommitCellEdit,
  onCommitDdl,
  onFetchTableExport,
  onStreamedExport,
  onApplyFilter,
  onColumnWidthsChange,
  onFetchBlob,
  onCountAllRows,
  onFetchScopedRows,
  onReconnect,
  plugins,
  onPickPluginPanel,
  onShowDdl,
  onBrowseTable,
  onCloseFocusedObject,
  showSettings,
  onCloseSettings,
  onOpenDeepSearch,
}: SessionViewProps) {
  const sidebarCollapsed = useThemeStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useThemeStore((s) => s.toggleSidebar);
  const [schemaEditorOpen, setSchemaEditorOpen] = useState(false);
  const [objectListKind, setObjectListKind] = useState<ObjectListKind | null>(null);
  const [newObjectKind, setNewObjectKind] = useState<NewObjectKind | null>(null);
  const [dbExportOpen, setDbExportOpen] = useState(false);
  if (!tab.sessionId) return null;
  return (
    <div className="flex flex-1 overflow-hidden">
      {sidebarCollapsed ? (
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="Expand schema sidebar"
          className="flex shrink-0 items-start border-r border-edge bg-canvas px-2 pt-3 text-fg-subtle hover:text-fg"
        >
          »
        </button>
      ) : (
        <div className="flex w-64 shrink-0 flex-col overflow-hidden">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Collapse schema sidebar"
            className="self-end px-2 text-fg-subtle hover:text-fg"
            title="Collapse sidebar"
          >
            «
          </button>
          <div className="flex-1 overflow-hidden">
            <SchemaBrowser
              schema={tab.schema}
              busy={tab.busy}
              onRefresh={onRefreshSchema}
              onSelect={(id) =>
                onSqlChange(
                  tab.sql.length > 0 && !tab.sql.endsWith(' ')
                    ? `${tab.sql} ${id}`
                    : `${tab.sql}${id}`,
                )
              }
              onOpenObject={(target) => {
                if (target.kind === 'table') {
                  void onBrowseTable(target.name);
                } else {
                  onShowDdl(target.kind, target.name);
                }
              }}
              onAction={onSchemaAction}
              onNewTable={() => setSchemaEditorOpen(true)}
              onPickObjectList={(kind) => setObjectListKind(kind)}
              onNewObject={(kind) => setNewObjectKind(kind)}
              onExportDatabase={() => setDbExportOpen(true)}
              engineVersion={tab.engineVersion}
              onShowDdl={onShowDdl}
              onOpenDeepSearch={onOpenDeepSearch}
            />
          </div>
          <PluginsSidebar plugins={plugins} onPickPanel={onPickPluginPanel} />
        </div>
      )}
      {showSettings ? (
        <SettingsPage onClose={onCloseSettings} backLabel="Back to session" />
      ) : objectListKind && tab.schema ? (
        <ObjectListPage
          kind={objectListKind}
          schema={tab.schema}
          onClose={() => setObjectListKind(null)}
          onCommit={onCommitDdl}
          onRefresh={onRefreshSchema}
          engineVersion={tab.engineVersion}
          onShowDdl={onShowDdl}
        />
      ) : (
        <main className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
          <QueryPanel
            sessionId={tab.sessionId}
            sql={tab.sql}
            busy={tab.busy}
            cryptState={tab.cryptState}
            schema={tab.schema}
            bookmarks={tab.bookmarks}
            health={tab.health}
            engineVersion={tab.engineVersion}
            encryptionKeySupplied={tab.form.encryptionKey.length > 0}
            onSqlChange={onSqlChange}
            onExecute={onExecute}
            onClose={onDisconnect}
            onBookmarksChange={onBookmarksChange}
            onOpenStats={onOpenStats}
            onReconnect={onReconnect}
          />

          {tab.error && <ErrorBanner error={tab.error} onDismiss={onClearError} />}

          {(() => {
            const focusedTable =
              tab.focusedObjectName && tab.schema
                ? tab.schema.tables.find((t) => t.name === tab.focusedObjectName) ?? null
                : null;
            if (focusedTable && tab.results && tab.results.length > 0) {
              return (
                <TableObjectView
                  table={focusedTable}
                  results={tab.results}
                  schema={tab.schema}
                  onClose={onCloseFocusedObject}
                  onRefreshData={() => void onBrowseTable(focusedTable.name)}
                  columnWidths={tab.columnWidths}
                  onColumnWidthsChange={onColumnWidthsChange}
                  onCommitCellEdit={onCommitCellEdit}
                  onApplyFilter={onApplyFilter}
                  onFetchBlob={onFetchBlob}
                  onCountAllRows={onCountAllRows}
                  onFetchScopedRows={onFetchScopedRows}
                  sessionId={tab.sessionId}
                />
              );
            }
            if (tab.results && tab.results.length > 0) {
              return (
                <MultiResultView
                  outcomes={tab.results}
                  schema={tab.schema}
                  onCommitCellEdit={onCommitCellEdit}
                  onApplyFilter={onApplyFilter}
                  columnWidths={tab.columnWidths}
                  onColumnWidthsChange={onColumnWidthsChange}
                  onFetchBlob={onFetchBlob}
                  onCountAllRows={onCountAllRows}
                  onFetchScopedRows={onFetchScopedRows}
                />
              );
            }
            return null;
          })() || (
            <WelcomeDashboard
              sessionId={tab.sessionId}
              user={tab.form.user}
              host={tab.form.host}
              port={tab.form.port}
              database={tab.form.database}
              engineVersion={tab.engineVersion}
              connectedAt={tab.connectedAt}
              schema={tab.schema}
              recentKey={recentKeyOf(tab.form, tab.profileName)}
              onPickRecent={(sql) => onSqlChange(sql)}
            />
          )}
        </main>
      )}
      <SchemaEditorModal
        open={schemaEditorOpen}
        domains={tab.schema?.domains ?? []}
        onClose={() => setSchemaEditorOpen(false)}
        onApply={(sql) => {
          const trimmed = tab.sql.replace(/\s+$/u, '');
          const next = trimmed.length === 0 ? sql : `${trimmed}\n\n${sql}`;
          onSqlChange(next);
        }}
      />
      <NewObjectModal
        open={newObjectKind !== null}
        kind={newObjectKind ?? 'view'}
        schema={tab.schema}
        onClose={() => setNewObjectKind(null)}
        onApply={(sql) => {
          const trimmed = tab.sql.replace(/\s+$/u, '');
          const next = trimmed.length === 0 ? sql : `${trimmed}\n\n${sql}`;
          onSqlChange(next);
        }}
      />
      <DatabaseExportModal
        open={dbExportOpen}
        schema={tab.schema}
        onClose={() => setDbExportOpen(false)}
        onFetchTable={onFetchTableExport}
        onStreamedExport={onStreamedExport}
        sessionId={tab.sessionId}
      />
    </div>
  );
}
