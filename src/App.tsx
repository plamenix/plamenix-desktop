import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CommandPalette,
  ConfirmationModal,
  ConnectionScreen,
  ErrorBanner,
  HistoryPanel,
  MultiResultView,
  DatabaseExportModal,
  NewObjectModal,
  ObjectListPage,
  PluginPanelModal,
  ToastViewport,
  notifyMutations,
  QueryPanel,
  SchemaBrowser,
  SchemaEditorModal,
  SettingsPage,
  SearchPalette,
  TableObjectView,
  RoutineObjectView,
  SqlEditorPage,
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
  registerBuiltinDefaultKeybindings,
  useConnectionActions,
  type ConnectionAdapter,
  registerBuiltinPluginSettings,
  editorSavingChain,
  installPluginInterceptors,
  installDestructiveDropInterceptor,
  setConfirmationProvider,
  type ConfirmationRequest,
  type PendingConfirmation,
  emitExportCompleted,
  emitExportFailed,
  emitExportStarted,
  emitSchemaActionApplied,
  emitEditorFocused,
  emitEditorSelectionChanged,
  exportStartingChain,
  newExportId,
  queryExecutingChain,
  schemaActionApplyingChain,
  useGlobalKeybindings,
  useConnectionPrefs,
  useEmitConnectionEvents,
  useEmitEditorEvents,
  useEmitLifecycleEvents,
  useEmitQueryEvents,
  useEmitSchemaEvents,
  useEmitSettingsThemeEvents,
  useEmitTabEvents,
  useResolvedThemeMode,
  useRecentQueries,
  useTabsStore,
  useThemeStore,
  type ActivePlugin,
  type ExtensionPoint,
  type PluginInterceptorOutcome,
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
  AboutPage,
  AppMenu,
  buildBuiltinActivePlugins,
  decodeHex,
  HomeButton,
  PluginsPage,
  type CryptState,
  type Profile,
  type ListAliasesResult,
  type Schema,
  type StatementOutcome,
  type TabState,
  type SchemaAction,
  type SchemaDdl,
  type TestConnectionResult,
  TransactionBar,
  hasUncommittedWork,
  type TxConfig,
  type TxMode,
  type TxStatus,
} from '@plamenix/ui';
import {
  ChartLine as ChartLineIcon,
  FileTerminal as SqlEditorIcon,
  History,
  Info as InfoIcon,
  LogOut as LogOutIcon,
  Plug as PluginsIcon,
  Settings as SettingsIcon,
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
import { openUrl } from '@tauri-apps/plugin-opener';

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

/** Builds a fallback DDL note shown when Firebird returns NULL for an
 *  object's `*_SOURCE` column. Common cause: the routine was compiled
 *  into BLR (binary form) without preserving its text — the legacy
 *  `employee.fdb` `GIVE_RAISE` procedure is the canonical example. */
function synthesizeMissingSourceNote(
  kind: DdlSourceKind,
  name: string,
  schema: Schema | null,
): string {
  const banner = [
    `-- ${kind.toUpperCase()} ${name}`,
    `--`,
    `-- Source text is not stored in this database.`,
    `-- RDB$${kind === 'view' ? 'RELATIONS.RDB$VIEW' : kind === 'trigger' ? 'TRIGGERS.RDB$TRIGGER' : 'PROCEDURES.RDB$PROCEDURE'}_SOURCE is NULL,`,
    `-- so the body was compiled into BLR (binary form) without`,
    `-- preserving the original text. This happens with older`,
    `-- Firebird samples (employee.fdb), or backups restored from`,
    `-- BLR-only \`.fbk\` files where source was stripped at backup.`,
    `--`,
  ];
  if (kind === 'procedure') {
    const proc = schema?.procedures?.find((p) => p.name === name);
    if (proc) {
      banner.push(
        `-- Signature: ${proc.inputCount} input(s), ${proc.outputCount} output(s)`,
        `--`,
        `-- Invoke with:`,
        proc.outputCount > 0
          ? `--   SELECT * FROM "${name}"(<inputs>);`
          : `--   EXECUTE PROCEDURE "${name}"(<inputs>);`,
      );
    }
  } else if (kind === 'trigger') {
    const trig = schema?.triggers?.find((t) => t.name === name);
    if (trig) {
      banner.push(
        `-- Fires on: ${trig.relation ?? '<database>'}`,
        `-- Active: ${trig.active ? 'YES' : 'NO'}`,
      );
    }
  } else if (kind === 'view') {
    const view = schema?.tables.find((t) => t.name === name && t.kind === 'view');
    if (view) {
      banner.push(`-- Columns: ${view.columns.length}`);
    }
  }
  return banner.join('\n');
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

// I6 event-bus identity. Keep in sync with package.json version on
// release-prep (no live import yet — vite JSON imports work but
// require the workspace to expose package.json to the bundler).
const HOST_VERSION = '1.0.0-beta.0';
const EDITION = 'desktop' as const;

export function App() {
  // I6.3-I6.6 + I6.8 + I6.10 + I6.11 — mount the seven event-bridge
  // hooks once at the App root. Each hook subscribes to its source
  // store + diffs/emits on every relevant transition. Order is
  // arbitrary; hooks are independent.
  useEmitLifecycleEvents({ edition: EDITION, hostVersion: HOST_VERSION });
  useEmitTabEvents();
  useEmitConnectionEvents();
  useEmitQueryEvents();
  useEmitSchemaEvents();
  useEmitSettingsThemeEvents();
  useEmitEditorEvents();

  // I6.12 — confirmation queue + provider + built-in destructive-DROP
  // interceptor. The queue keeps multiple in-flight confirmations
  // ordered; each user action resolves exactly one request.
  const [confirmQueue, setConfirmQueue] = useState<
    Array<PendingConfirmation & { resolve: (v: boolean) => void }>
  >([]);
  useEffect(() => {
    setConfirmationProvider(
      (req: ConfirmationRequest) =>
        new Promise<boolean>((resolve) => {
          setConfirmQueue((q) => [...q, { ...req, resolve }]);
        }),
    );
    const dropReg = installDestructiveDropInterceptor();
    return () => {
      setConfirmationProvider(null);
      dropReg.dispose();
    };
  }, []);
  const confirmHead = confirmQueue[0] ?? null;
  const onConfirmHead = useCallback(() => {
    setConfirmQueue((q) => {
      const [head, ...rest] = q;
      head?.resolve(true);
      return rest;
    });
  }, []);
  const onCancelHead = useCallback(() => {
    setConfirmQueue((q) => {
      const [head, ...rest] = q;
      head?.resolve(false);
      return rest;
    });
  }, []);

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

  const [plugins, setPlugins] = useState<ActivePlugin[]>([]);
  const [openPluginPanel, setOpenPluginPanel] = useState<{
    plugin: ActivePlugin;
    panel: SidebarPanelInfo;
  } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSqlEditor, setShowSqlEditor] = useState(false);
  const APP_VERSION = '1.0.0-beta.0';

  useEffect(() => {
    const fetchPlugins = async () => {
      // Built-ins are synchronous + always available, so they surface
      // even if the Rust-side plugin host hasn't booted yet (e.g.
      // bootstrap still running, or every wasm plugin failed to load).
      const builtins = buildBuiltinActivePlugins();
      try {
        const list = await tauriTransport.invoke<ActivePlugin[]>('plugin_list_active');
        setPlugins([...builtins, ...list]);
      } catch {
        // Wasm-side fetch is best-effort; built-ins still surface.
        setPlugins(builtins);
      }
    };
    // First fetch at mount in case the bootstrap already finished (e.g.
    // window reloaded after first launch). The `boot:ready` listener
    // catches the cold-start race where the main window mounts before
    // the plugin bootstrap completes.
    void fetchPlugins();
    // Built-ins land asynchronously — each lives behind a `useEffect`
    // in its consumer component (ResultTable, SchemaBrowser, etc).
    // A short deferred re-fetch picks them up once children mount,
    // without needing to subscribe to every registry channel.
    const builtinSettleTimeout = window.setTimeout(() => {
      void fetchPlugins();
    }, 800);
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen('boot:ready', () => {
        void fetchPlugins();
      }).then((fn) => {
        unlisten = fn;
      }),
    );
    return () => {
      window.clearTimeout(builtinSettleTimeout);
      if (unlisten) unlisten();
    };
  }, []);

  // Wires activated plugins into the interceptor chains. Separate from
  // the effect above because that one is about what the plugins panel
  // displays; this one is about plugins being able to refuse or rewrite
  // an operation, and it has to re-run whenever the set of activated
  // plugins changes.
  useEffect(() => {
    let handle: { dispose(): void } | null = null;
    let cancelled = false;
    void installPluginInterceptors({
      listInterceptors: () =>
        tauriTransport.invoke<Array<{ extensionPoint: ExtensionPoint }>>(
          'plugin_list_interceptors',
        ),
      runInterceptors: (extensionPoint, contextJson) =>
        tauriTransport.invoke<PluginInterceptorOutcome>('plugin_run_interceptors', {
          extensionPoint,
          contextJson,
        }),
    }).then((installed) => {
      // A reload that resolved after unmount would otherwise leave a
      // handler registered against a chain nobody disposes.
      if (cancelled) installed.dispose();
      else handle = installed;
    });
    return () => {
      cancelled = true;
      handle?.dispose();
    };
  }, [plugins.length]);

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

  const refreshStats = useCallback(async (sessionId: string) => {
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
  }, []);

  const computeRowCounts = useCallback(async () => {
    const tab = activeTab;
    if (!tab.sessionId || !tab.schema) return [];
    const out: { name: string; kind: 'table' | 'view'; count: number | null; error?: string }[] =
      [];
    for (const t of tab.schema.tables) {
      const ident = `"${t.name.replace(/"/g, '""')}"`;
      try {
        const outcomes = await tauriTransport.invoke<StatementOutcome[]>('db_execute', {
          request: {
            sessionId: tab.sessionId,
            sql: `SELECT COUNT(*) FROM ${ident}`,
            profileId: null,
            historyLimit: 0,
          },
        });
        const first = outcomes[0];
        if (!first || first.status === 'err' || !('Rows' in first.result)) {
          out.push({
            name: t.name,
            kind: t.kind === 'view' ? 'view' : 'table',
            count: null,
            error: first?.status === 'err' ? first.error : 'count produced no row',
          });
          continue;
        }
        const cell = first.result.Rows.rows[0]?.cells[0];
        const count = cell?.type === 'integer' && cell.value !== null ? Number(cell.value) : null;
        out.push({
          name: t.name,
          kind: t.kind === 'view' ? 'view' : 'table',
          count,
        });
      } catch (err) {
        out.push({
          name: t.name,
          kind: t.kind === 'view' ? 'view' : 'table',
          count: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }, [activeTab]);

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
      const tabId = tab.id;
      // Surface the routine in the content pane (clearing any focused
      // table) so the inspector replaces the bare query results without
      // an intrusive modal overlay.
      patchTab(tabId, {
        focusedObjectName: null,
        focusedRoutine: { kind, name, source: null, loading: true, error: null },
      });
      // Generators + domains have no `*_SOURCE` column in Firebird's
      // metadata — synthesize a minimal `CREATE …` DDL from the
      // already-cached schema instead of running a query.
      if (kind === 'generator') {
        const gen = tab.schema?.generators?.find((g) => g.name === name);
        const source = gen
          ? `CREATE SEQUENCE "${name}" START WITH ${gen.currentValue};`
          : `-- Generator ${name} not found in the cached schema.`;
        patchTab(tabId, {
          focusedRoutine: { kind, name, source, loading: false, error: null },
        });
        return;
      }
      if (kind === 'domain') {
        const dom = tab.schema?.domains?.find((d) => d.name === name);
        const source = dom
          ? `CREATE DOMAIN "${name}" AS ${dom.sqlType}${dom.nullable ? '' : ' NOT NULL'};`
          : `-- Domain ${name} not found in the cached schema.`;
        patchTab(tabId, {
          focusedRoutine: { kind, name, source, loading: false, error: null },
        });
        return;
      }
      if (!tab.sessionId) {
        patchTab(tabId, {
          focusedRoutine: {
            kind,
            name,
            source: null,
            loading: false,
            error: 'Connect to a database first to view DDL.',
          },
        });
        return;
      }
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
        if (cell?.type === 'text') {
          source = cell.value;
        } else if (cell?.type === 'null') {
          source = '';
        } else if (cell?.type === 'blob') {
          // Firebird stores routine/view bodies in `BLOB SUB_TYPE TEXT`
          // columns. The driver inlines short text blobs as 'text' but
          // larger ones (e.g. multi-page procedure bodies) arrive as
          // blob refs — fetch the bytes and decode UTF-8.
          const hex = await tauriTransport.invoke<string>('db_fetch_blob', {
            sessionId: tab.sessionId,
            blobId: cell.value.id,
          });
          source = new TextDecoder('utf-8', { fatal: false }).decode(decodeHex(hex));
        }
        // Some procedures / triggers / views ship with NULL source
        // (RDB$PROCEDURE_SOURCE etc. is `null`) — the body was compiled
        // into BLR without preserving its text. Surface that honestly
        // and give the user something they can run instead of an empty
        // pane. Classic offender: the Firebird `employee.fdb`
        // `GIVE_RAISE` procedure restored from an older `.fbk`.
        if (source.trim().length === 0) {
          source = synthesizeMissingSourceNote(kind, name, tab.schema);
        }
        patchTab(tabId, {
          focusedRoutine: { kind, name, source, loading: false, error: null },
        });
      } catch (err) {
        patchTab(tabId, {
          focusedRoutine: {
            kind,
            name,
            source: null,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    },
    [activeTab, patchTab],
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

  const deleteHistoryEntry = useCallback(async (id: number) => {
    await tauriTransport.invoke<boolean>('history_delete', { id });
    setHistoryEntries((prev) => (prev ? prev.filter((e) => e.id !== id) : prev));
  }, []);

  const deleteHistoryEntries = useCallback(async (ids: number[]) => {
    if (ids.length === 0) return;
    await tauriTransport.invoke<number>('history_delete_many', {
      request: { ids },
    });
    const drop = new Set(ids);
    setHistoryEntries((prev) => (prev ? prev.filter((e) => !drop.has(e.id)) : prev));
  }, []);

  const setHistoryLabel = useCallback(
    async (id: number, label: string | null) => {
      await tauriTransport.invoke<boolean>('history_set_label', {
        request: { id, label },
      });
      const normalized = label && label.trim().length > 0 ? label.trim() : null;
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
    const extensions = isMac ? ['dylib'] : isWindows ? ['dll'] : ['so', 'so.*'];
    const result = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: 'Firebird client library', extensions }],
    });
    return typeof result === 'string' ? result : null;
  }, []);

  const handleBrowseDatabase = useCallback(async (): Promise<string | null> => {
    const result = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: 'Firebird database', extensions: ['fdb', 'gdb'] }],
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

  const handleDownloadFbclient = useCallback(async (version?: string): Promise<string> => {
    const res = await tauriTransport.invoke<{ path: string; version: string }>(
      'fbclient_download',
      version === undefined ? {} : { version },
    );
    return res.path;
  }, []);

  const [fbclientReleases, setFbclientReleases] = useState<{ version: string }[] | null>(null);
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
    // Pull the freshest tab.form from the store rather than spreading
    // the closure-captured `activeTab.form`. Multiple back-to-back
    // updateField calls inside one click handler would otherwise read
    // the SAME stale closure value and clobber each other's writes.
    const fresh = useTabsStore.getState().tabs.find((t) => t.id === activeTabId);
    if (!fresh) return;
    patchTab(activeTabId, {
      form: { ...fresh.form, [key]: value },
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
        embedded: profile.embedded ?? false,
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
        embedded: tab.form.embedded,
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
          fbclientPath: activeTab.form.fbclientPath === '' ? null : activeTab.form.fbclientPath,
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
      void refreshTxStatus(tabId, response.sessionId);
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  // Connect, reconnect, test, the health probe and auto-reconnect all
  // live in `@plamenix/ui` now — the web shell ran a near-identical copy
  // of every one of them, and one of the two had already drifted. What
  // stays here is the part that is genuinely this edition's: Tauri
  // command names, and `null` rather than `undefined` for an absent
  // optional field.
  const connectionAdapter = useMemo<ConnectionAdapter>(
    () => ({
      connect: ({ form, profileId }) =>
        profileId !== null
          ? tauriTransport.invoke<ConnectResponse>('profile_connect', {
              request: {
                profileId,
                password: form.password === '' ? null : form.password,
                encryptionKey: form.encryptionKey === '' ? null : form.encryptionKey,
                pureRust: form.pureRust,
                encryptionRequired: form.encryptionRequired,
                fbclientPath: form.fbclientPath === '' ? null : form.fbclientPath,
                charset: form.charset === '' ? null : form.charset,
                embedded: form.embedded,
              },
            })
          : tauriTransport.invoke<ConnectResponse>('db_connect', {
              request: {
                host: form.host,
                port: form.port,
                database: form.database,
                user: form.user,
                password: form.password,
                encryptionKey: form.encryptionKey === '' ? null : form.encryptionKey,
                encryptionRequired: form.encryptionRequired,
                pureRust: form.pureRust,
                fbclientPath: form.fbclientPath === '' ? null : form.fbclientPath,
                charset: form.charset === '' ? null : form.charset,
                embedded: form.embedded,
              },
            }),
      testConnection: (form) =>
        tauriTransport.invoke<TestConnectionResult>('db_test_connection', {
          request: {
            host: form.host,
            port: form.port,
            database: form.database,
            user: form.user,
            password: form.password,
            encryptionKey: form.encryptionKey === '' ? null : form.encryptionKey,
            encryptionRequired: form.encryptionRequired,
            pureRust: form.pureRust,
            fbclientPath: form.fbclientPath === '' ? null : form.fbclientPath,
            charset: form.charset === '' ? null : form.charset,
          },
        }),
      pingSession: (sessionId) => tauriTransport.invoke<string>('db_ping', { sessionId }),
    }),
    [],
  );

  const autoReconnect = useConnectionPrefs((s) => s.autoReconnect);
  const { handleConnect, handleReconnect, handleTestConnection } = useConnectionActions({
    adapter: connectionAdapter,
    activeTab,
    tabs,
    patchTab,
    renameTab,
    deriveTitle,
    autoReconnect,
    onConnected: (tabId, sessionId) => {
      void refreshCryptState(tabId, sessionId);
      void refreshSchema(tabId, sessionId);
      void refreshEngineVersion(tabId, sessionId);
      void refreshTxStatus(tabId, sessionId);
    },
  });


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
    const editorDecision = await editorSavingChain.run({
      tabId,
      sessionId: tab.sessionId,
      sql: sqlAtSend,
    });
    if (editorDecision.action === 'cancel') {
      patchTab(tabId, { error: editorDecision.reason });
      return;
    }
    const sqlAfterEditor = editorDecision.action === 'replace' ? editorDecision.ctx.sql : sqlAtSend;
    const queryDecision = await queryExecutingChain.run({
      tabId,
      sessionId: tab.sessionId,
      sql: sqlAfterEditor,
    });
    if (queryDecision.action === 'cancel') {
      patchTab(tabId, { error: queryDecision.reason });
      return;
    }
    const sql = queryDecision.action === 'replace' ? queryDecision.ctx.sql : sqlAfterEditor;
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
      patchTab(tabId, {
        results: res,
        executedSql: sql,
        focusedObjectName: null,
        focusedRoutine: null,
      });
      notifyMutations(res);
      recordExec(key, sql, startedAt, res, null);
      // Manual mode opens the transaction on the first statement and
      // counts each one after that, so the indicator needs a refresh.
      if (tab.sessionId) void refreshTxStatus(tabId, tab.sessionId);
    } catch (err) {
      patchTab(tabId, { error: String(err) });
      recordExec(key, sql, startedAt, null, String(err));
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
        const outcomes = await tauriTransport.invoke<StatementOutcome[]>('db_execute', {
          request: {
            sessionId: tab.sessionId,
            sql,
            profileId: tab.selectedProfileId,
            historyLimit: currentHistoryLimit(),
          },
        });
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
      const exportId = newExportId();
      const startedAt = Date.now();
      const scopeLabel =
        req.scope.kind === 'statement'
          ? (req.scope.label ?? req.scope.table?.name ?? req.scope.sql.slice(0, 80))
          : req.scope.tables.map((t) => t.name).join(', ');
      const tables =
        req.scope.kind === 'statement'
          ? req.scope.table
            ? [req.scope.table.name]
            : []
          : req.scope.tables.map((t) => t.name);
      const exportDecision = await exportStartingChain.run({
        tabId: activeTab.id,
        sessionId: req.sessionId,
        format: req.format,
        scopeKind: req.scope.kind,
        scopeLabel,
        tables,
      });
      if (exportDecision.action === 'cancel') {
        throw new Error(exportDecision.reason);
      }
      emitExportStarted({
        exportId,
        tabId: activeTab.id,
        sessionId: req.sessionId,
        format: req.format,
        scopeKind: req.scope.kind,
        scopeLabel,
        startedAt,
      });
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
        await listen<{ exportId: string; seq: number; text: string }>('export:chunk', (event) => {
          if (expectedId === null || event.payload.exportId === expectedId) {
            chunks[event.payload.seq] = event.payload.text;
          }
        }),
      );
      unsubs.push(
        await listen<{ exportId: string; totalBytes: number }>('export:done', (event) => {
          if (expectedId === null || event.payload.exportId === expectedId) {
            resolveDone?.();
          }
        }),
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
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
        emitExportCompleted({
          exportId,
          durationMs: Date.now() - startedAt,
          byteSize: blob.size,
          rowCount: null,
          completedAt: Date.now(),
        });
        return {
          blob,
          suggestedFilename: `plamenix-export-${stamp}.${req.format}`,
        };
      } catch (err) {
        emitExportFailed({
          exportId,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
          failedAt: Date.now(),
        });
        throw err;
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
      const outcomes = await tauriTransport.invoke<StatementOutcome[]>('db_execute', {
        request: {
          sessionId: tab.sessionId,
          sql: `SELECT * FROM ${quoted}`,
          profileId: tab.selectedProfileId,
          historyLimit: currentHistoryLimit(),
        },
      });
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
      const quoted = /^[A-Z_][A-Z0-9_]*$/.test(table) ? table : `"${table.replace(/"/g, '""')}"`;
      const sql = predicate
        ? `SELECT COUNT(*) FROM ${quoted} WHERE ${predicate}`
        : `SELECT COUNT(*) FROM ${quoted}`;
      const outcomes = await tauriTransport.invoke<StatementOutcome[]>('db_execute', {
        request: {
          sessionId: tab.sessionId,
          sql,
          profileId: tab.selectedProfileId,
          historyLimit: currentHistoryLimit(),
        },
      });
      const first = outcomes[0];
      if (!first || first.status !== 'ok' || !('Rows' in first.result)) {
        throw new Error('COUNT(*) did not return a row.');
      }
      const cell = first.result.Rows.rows[0]?.cells[0];
      if (!cell) throw new Error('COUNT(*) returned an empty row.');
      if (cell.type === 'integer') {
        // Integers cross the wire as exact decimal text so a BIGINT
        // survives the JSON hop. A row count is bounded by what the UI
        // can page through, so narrowing it here is safe.
        const parsed = Number(cell.value);
        if (!Number.isFinite(parsed)) {
          throw new Error(`COUNT(*) returned an unparseable value: ${cell.value}.`);
        }
        return parsed;
      }
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
      const quoted = /^[A-Z_][A-Z0-9_]*$/.test(table) ? table : `"${table.replace(/"/g, '""')}"`;
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
      const quoted = /^[A-Z_][A-Z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
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
        // Sync the editor buffer to the executed query so the SQL
        // editor always reflects what produced the result pane —
        // browsing a table, applying a filter, etc. The previous
        // behaviour preserved user-in-progress SQL; users found it
        // confusing because the editor and results pane drifted apart.
        patchTab(tabId, { results: res, sql, executedSql: sql, focusedObjectName: name });
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
        patchTab(tabId, { results: res, sql, executedSql: sql });
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

  /** I5.5 — dispatch a fully-resolved `SchemaDdl` through the same
   *  autoExecute / insert-into-editor / confirm-then-run pipeline the
   *  built-in `SchemaAction` handler uses. Plugin schema_actions go
   *  through this directly; built-in actions go through
   *  `handleSchemaAction` → `schemaDdl(action)` → here. */
  const dispatchDdl = async (ddl: SchemaDdl): Promise<boolean> => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (ddl.autoExecute) {
      if (!tab.sessionId) return false;
      const key = recentKeyOf(tab.form, tab.profileName);
      const startedAt = Date.now();
      patchTab(tabId, { error: null, busy: true });
      let executed = false;
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
        executed = true;
      } catch (err) {
        patchTab(tabId, { error: String(err) });
        recordExec(key, ddl.sql, startedAt, null, String(err));
      } finally {
        patchTab(tabId, { busy: false });
      }
      return executed;
    }
    if (!ddl.destructive) {
      patchTab(tabId, { sql: ddl.sql });
      return false;
    }
    if (!window.confirm(ddl.confirmPrompt ?? 'Run destructive statement?')) return false;
    if (!tab.sessionId) return false;
    const key = recentKeyOf(tab.form, tab.profileName);
    const startedAt = Date.now();
    patchTab(tabId, { error: null, busy: true, sql: ddl.sql });
    let executed = false;
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
      executed = true;
    } catch (err) {
      patchTab(tabId, { error: String(err) });
      recordExec(key, ddl.sql, startedAt, null, String(err));
    } finally {
      patchTab(tabId, { busy: false });
    }
    return executed;
  };

  const handleSchemaAction = async (action: SchemaAction) => {
    const ddl = schemaDdl(action);
    if (activeTab.sessionId !== null) {
      const decision = await schemaActionApplyingChain.run({
        tabId: activeTabId,
        sessionId: activeTab.sessionId,
        kind: action.kind,
        action: action.action,
        targetName: action.target.name,
        ddl: ddl.sql,
      });
      if (decision.action === 'cancel') {
        patchTab(activeTabId, { error: decision.reason });
        return;
      }
    }
    const executed = await dispatchDdl(ddl);
    if (executed) {
      emitSchemaActionApplied({
        tabId: activeTabId,
        sessionId: activeTab.sessionId,
        kind: action.kind,
        action: action.action,
        targetName: action.target.name,
        ddl: ddl.sql,
        appliedAt: Date.now(),
      });
    }
  };

  /// Pulls the session's transaction state into the tab.
  ///
  /// Called after anything that can change it — connect, execute,
  /// commit, rollback — so the indicator reflects the session rather
  /// than what the UI last assumed.
  const refreshTxStatus = useCallback(
    async (tabId: string, sessionId: string) => {
      try {
        const status = await tauriTransport.invoke<TxStatus>('db_transaction_status', {
          sessionId,
        });
        patchTab(tabId, { txStatus: status });
      } catch {
        // A status read failing is not worth surfacing on its own; the
        // next real operation will report the underlying problem.
      }
    },
    [patchTab],
  );

  const handleSetTxMode = async (mode: TxMode, config: TxConfig) => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (!tab.sessionId) return;
    patchTab(tabId, { busy: true });
    try {
      const status = await tauriTransport.invoke<TxStatus>('db_set_transaction_mode', {
        sessionId: tab.sessionId,
        mode,
        config,
      });
      patchTab(tabId, { txStatus: status, error: null });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const finishTx = async (command: 'db_commit' | 'db_rollback') => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (!tab.sessionId) return;
    patchTab(tabId, { busy: true });
    try {
      const status = await tauriTransport.invoke<TxStatus>(command, {
        sessionId: tab.sessionId,
      });
      patchTab(tabId, { txStatus: status, error: null });
      // Committed or discarded work changes what the schema looks like,
      // since Firebird makes DDL transactional too.
      void refreshSchema(tabId, tab.sessionId);
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  /// Asks before throwing away uncommitted work.
  ///
  /// Returns false when the user backs out. An open transaction with
  /// nothing in it is not worth interrupting anyone over, which is what
  /// `hasUncommittedWork` encodes.
  const confirmDiscardTx = (tab: TabState, what: string): boolean => {
    if (!hasUncommittedWork(tab.txStatus)) return true;
    const count = tab.txStatus?.pendingStatements ?? 0;
    const statements = count === 1 ? '1 statement' : `${count} statements`;
    return window.confirm(
      `${what} will roll back ${statements} that have not been committed. Continue?`,
    );
  };

  const handleDisconnect = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (!tab.sessionId) return;
    if (!confirmDiscardTx(tab, 'Disconnecting')) return;
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
        txStatus: null,
      });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleTabClose = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab && !confirmDiscardTx(tab, 'Closing this tab')) return;
    if (tab?.sessionId) {
      void tauriTransport.invoke<null>('db_close', { sessionId: tab.sessionId }).catch(() => {});
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

  // I5.1 — keybindings now live in the registry. The dispatcher
  // hook walks `keybindings` contributions in priority order on
  // every keydown; the built-in `@plamenix-builtin/default-keybindings`
  // registration below carries the six shell defaults that used to
  // live in a 40-line inline switch here. Third-party plugins can
  // override individual combos by registering at lower priority.
  useGlobalKeybindings();
  useEffect(() => {
    return registerBuiltinDefaultKeybindings({
      openCheatSheet: () => handlersRef.current.setShortcutsOpen(true),
      openSearchPalette: () => handlersRef.current.setSearchOpen(true),
      openCommandPalette: () => handlersRef.current.setPaletteOpen(true),
      newTab: () => handlersRef.current.newTab(),
      closeActiveTab: () => handlersRef.current.handleTabClose(handlersRef.current.activeTabId),
      canSaveProfile: () => {
        const t = handlersRef.current.activeTab;
        return t.sessionId === null && t.profileName.trim() !== '' && !t.busy;
      },
      saveActiveProfile: () => void handlersRef.current.handleSaveProfile(),
    });
  }, []);
  // Per-plugin settings — 6 built-ins ship a runtime-configurable
  // panel that PluginsPage renders inline in the matching card.
  useEffect(() => registerBuiltinPluginSettings(), []);
  // After a webview reload (context-menu Reload, devtools refresh)
  // React state is wiped but the Rust-side wasmtime session may still
  // be alive. We persist sessionIds to **sessionStorage** (not
  // localStorage) so reload restores them but a full app restart —
  // which destroys the WebView + the Rust process together — wipes
  // them. This effect pings each restored sessionId: alive ones get
  // re-attached + their schema refetched; dead ones get cleared so
  // the user lands on ConnectView instead of a phantom-connected tab.
  useEffect(() => {
    const verify = async () => {
      for (const tab of useTabsStore.getState().tabs) {
        const stashed = readStashedSession(tab.id);
        if (!stashed) continue;
        try {
          const version = await tauriTransport.invoke<string>('db_ping', {
            sessionId: stashed,
          });
          patchTab(tab.id, {
            sessionId: stashed,
            engineVersion: version,
            health: 'healthy',
            lastPingAt: Date.now(),
          });
          void refreshSchema(tab.id, stashed);
        } catch {
          clearStashedSession(tab.id);
          patchTab(tab.id, {
            sessionId: null,
            health: 'dead',
            executedSql: null,
            results: null,
            schema: null,
            cryptState: null,
          });
        }
      }
    };
    void verify();
  }, []);
  // Mirror every live tab.sessionId into sessionStorage so the verify
  // effect above has something to find on reload.
  useEffect(() => {
    for (const tab of tabs) {
      if (tab.sessionId) writeStashedSession(tab.id, tab.sessionId);
      else clearStashedSession(tab.id);
    }
  }, [tabs]);
  // Any session-navigation (browse a table, run a query, surface DDL,
  // etc.) makes the Plugins / Settings / About overlays stale — auto-
  // close them so the user lands on the new content directly without
  // an extra "Back to session" click.
  useEffect(() => {
    if (
      activeTab.focusedObjectName !== null ||
      activeTab.focusedRoutine !== null ||
      activeTab.results !== null
    ) {
      setShowPlugins(false);
      setShowSettings(false);
      setShowAbout(false);
    }
  }, [activeTab.focusedObjectName, activeTab.focusedRoutine, activeTab.results]);

  // Surfacing a focused table / routine should also collapse the
  // full-screen SQL Editor page so the user lands on the new content,
  // but a bare result-set change must NOT (running a query from inside
  // the editor page is the whole point — results render below in-page).
  useEffect(() => {
    if (activeTab.focusedObjectName !== null || activeTab.focusedRoutine !== null) {
      setShowSqlEditor(false);
    }
  }, [activeTab.focusedObjectName, activeTab.focusedRoutine]);
  // Tauri's WKWebView blocks external navigation by default. Route every
  // anchor click whose href looks external through the opener plugin so
  // it lands in the user's system default browser. Capture phase so the
  // listener runs before React's bubble-phase handlers and before any
  // ancestor's `onClick` can preventDefault.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement | null)?.closest('a');
      if (!target) return;
      const href = target.getAttribute('href') ?? '';
      if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      openUrl(href).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('openUrl failed', err);
      });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
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
        <div className="flex shrink-0 items-stretch">
          {activeTab.sessionId !== null && (
            <HomeButton
              active={
                !showSettings &&
                !showAbout &&
                !showPlugins &&
                !showSqlEditor &&
                activeTab.focusedObjectName === null &&
                activeTab.focusedRoutine === null &&
                activeTab.results === null
              }
              onClick={() => {
                setShowSettings(false);
                setShowAbout(false);
                setShowPlugins(false);
                setShowSqlEditor(false);
                patchTab(activeTabId, {
                  focusedObjectName: null,
                  focusedRoutine: null,
                  results: null,
                  executedSql: null,
                });
              }}
            />
          )}
          <AppMenu
            items={[
              {
                id: 'plugins',
                icon: PluginsIcon,
                label: 'Plugins',
                badge: String(plugins.length),
                onClick: () => {
                  setShowSettings(false);
                  setShowAbout(false);
                  setShowPlugins(true);
                },
              },
              {
                id: 'settings',
                icon: SettingsIcon,
                label: 'Settings',
                onClick: () => {
                  setShowPlugins(false);
                  setShowAbout(false);
                  setShowSettings(true);
                },
              },
              {
                id: 'about',
                icon: InfoIcon,
                label: 'About',
                onClick: () => {
                  setShowPlugins(false);
                  setShowSettings(false);
                  setShowAbout(true);
                },
              },
              ...(activeTab.sessionId !== null
                ? [
                    {
                      id: 'stats',
                      icon: ChartLineIcon,
                      label: 'Statistics',
                      dividerAbove: true,
                      onClick: () => {
                        setShowPlugins(false);
                        setShowSettings(false);
                        setShowAbout(false);
                        openStats();
                      },
                    },
                    {
                      id: 'disconnect',
                      icon: LogOutIcon,
                      label: 'Disconnect',
                      danger: true,
                      dividerAbove: true,
                      onClick: () => {
                        void handleDisconnect();
                      },
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </div>
      {showAbout && activeTab.sessionId === null ? (
        <AboutPage
          version={APP_VERSION}
          onClose={() => setShowAbout(false)}
          backLabel="Back to connections"
        />
      ) : showPlugins && activeTab.sessionId === null ? (
        <PluginsPage
          plugins={plugins}
          onClose={() => setShowPlugins(false)}
          backLabel="Back to connections"
        />
      ) : showSettings && activeTab.sessionId === null ? (
        <SettingsPage onClose={() => setShowSettings(false)} backLabel="Back to connections" />
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
          onBrowseDatabase={handleBrowseDatabase}
          onBrowseFbclientDir={handleBrowseFbclientDir}
          onDownloadFbclient={handleDownloadFbclient}
          fbclientReleases={fbclientReleases}
        />
      ) : (
        <SessionView
          tab={activeTab}
          showSettings={showSettings}
          onCloseSettings={() => setShowSettings(false)}
          showPlugins={showPlugins}
          onClosePlugins={() => setShowPlugins(false)}
          showAbout={showAbout}
          onCloseAbout={() => setShowAbout(false)}
          showSqlEditor={showSqlEditor}
          onOpenSqlEditor={() => {
            patchTab(activeTabId, {
              focusedObjectName: null,
              focusedRoutine: null,
            });
            setShowSqlEditor(true);
          }}
          onCloseSqlEditor={() => setShowSqlEditor(false)}
          appVersion={APP_VERSION}
          onCloseFocusedObject={() => patchTab(activeTabId, { focusedObjectName: null })}
          onCloseFocusedRoutine={() => patchTab(activeTabId, { focusedRoutine: null })}
          onOpenDeepSearch={() => setSearchOpen(true)}
          onSqlChange={(v) => patchTab(activeTabId, { sql: v })}
          onBookmarksChange={(next) => patchTab(activeTabId, { bookmarks: next })}
          onExecute={handleExecute}
          onDisconnect={handleDisconnect}
          onSetTxMode={(mode, config) => void handleSetTxMode(mode, config)}
          onCommitTx={() => void finishTx('db_commit')}
          onRollbackTx={() => void finishTx('db_rollback')}
          onOpenStats={openStats}
          stats={stats}
          onRefreshStats={() => void refreshStats(activeTab.sessionId ?? '')}
          onComputeRowCounts={computeRowCounts}
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
          onPluginDdl={dispatchDdl}
          onClearError={() => patchTab(activeTabId, { error: null })}
          plugins={plugins}
          onShowDdl={handleShowDdl}
          onBrowseTable={handleBrowseTable}
        />
      )}
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
      <ShortcutsCheatSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
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
            : null) ??
          activeTab.profileName ??
          'No profile'
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
      <ConfirmationModal request={confirmHead} onConfirm={onConfirmHead} onCancel={onCancelHead} />
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
  onBrowseDatabase: () => Promise<string | null>;
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
  onBrowseDatabase,
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
        onBrowseDatabase={onBrowseDatabase}
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
  onSetTxMode: (mode: TxMode, config: TxConfig) => void;
  onCommitTx: () => void;
  onRollbackTx: () => void;
  onRefreshSchema: () => void;
  onSchemaAction: (action: SchemaAction) => void;
  onPluginDdl: (ddl: SchemaDdl) => void;
  onClearError: () => void;
  onOpenStats: () => void;
  stats: DatabaseStats | null;
  onRefreshStats: () => void;
  onComputeRowCounts: () => Promise<
    { name: string; kind: 'table' | 'view'; count: number | null; error?: string }[]
  >;
  onCommitCellEdit: (sql: string) => Promise<void>;
  onCommitDdl: (sql: string) => Promise<void>;
  onFetchTableExport: (table: TableInfo) => Promise<TableExportPart>;
  onStreamedExport: StreamedExportRunner;
  onApplyFilter: (sql: string) => Promise<void>;
  onColumnWidthsChange: (next: Record<string, number>) => void;
  onFetchBlob: (blobId: string) => Promise<string>;
  onCountAllRows: (args: { table: string; predicate: string | null }) => Promise<number>;
  onFetchScopedRows: (args: {
    table: string;
    predicate: string | null;
  }) => Promise<{ cells: ColumnValue[] }[]>;
  onReconnect: () => void;
  plugins: ActivePlugin[];
  onShowDdl: (kind: DdlSourceKind, name: string) => void;
  onBrowseTable: (name: string) => Promise<void>;
  onCloseFocusedObject: () => void;
  onCloseFocusedRoutine: () => void;
  showSettings: boolean;
  onCloseSettings: () => void;
  showPlugins: boolean;
  onClosePlugins: () => void;
  showAbout: boolean;
  onCloseAbout: () => void;
  showSqlEditor: boolean;
  onOpenSqlEditor: () => void;
  onCloseSqlEditor: () => void;
  appVersion: string;
  onOpenDeepSearch: () => void;
}

const SESSION_KEY_PREFIX = 'plamenix.session.';

function readStashedSession(tabId: string): string | null {
  try {
    return window.sessionStorage.getItem(SESSION_KEY_PREFIX + tabId);
  } catch {
    return null;
  }
}

function writeStashedSession(tabId: string, sessionId: string): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY_PREFIX + tabId, sessionId);
  } catch {
    /* sessionStorage unavailable — silent no-op. */
  }
}

function clearStashedSession(tabId: string): void {
  try {
    window.sessionStorage.removeItem(SESSION_KEY_PREFIX + tabId);
  } catch {
    /* no-op. */
  }
}

function summariseResults(
  results: StatementOutcome[] | null,
): { totalDurationMs: number; totalRows: number; statementCount: number } | null {
  if (!results || results.length === 0) return null;
  let totalDurationMs = 0;
  let totalRows = 0;
  for (const r of results) {
    totalDurationMs += r.durationMs;
    if (r.status === 'ok' && 'Rows' in r.result) {
      totalRows += r.result.Rows.rows.length;
    }
  }
  return { totalDurationMs, totalRows, statementCount: results.length };
}

function SessionView({
  tab,
  onSqlChange,
  onBookmarksChange,
  onExecute,
  onDisconnect,
  onSetTxMode,
  onCommitTx,
  onRollbackTx,
  onRefreshSchema,
  onSchemaAction,
  onPluginDdl,
  onClearError,
  onOpenStats,
  stats,
  onRefreshStats,
  onComputeRowCounts,
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
  onShowDdl,
  onBrowseTable,
  onCloseFocusedObject,
  onCloseFocusedRoutine,
  showSettings,
  onCloseSettings,
  showPlugins,
  onClosePlugins,
  showAbout,
  onCloseAbout,
  showSqlEditor,
  onOpenSqlEditor,
  onCloseSqlEditor,
  appVersion,
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
                // Tables AND views support `SELECT * FROM <name>` —
                // route both through the rich TableObjectView so views
                // get their data tab, not just a DDL dump.
                if (target.kind === 'table' || target.kind === 'view') {
                  void onBrowseTable(target.name);
                } else {
                  onShowDdl(target.kind, target.name);
                }
              }}
              onAction={onSchemaAction}
              onPluginDdl={onPluginDdl}
              onNewTable={() => setSchemaEditorOpen(true)}
              onPickObjectList={(kind) => setObjectListKind(kind)}
              onNewObject={(kind) => setNewObjectKind(kind)}
              onExportDatabase={() => setDbExportOpen(true)}
              engineVersion={tab.engineVersion}
              onShowDdl={onShowDdl}
              onOpenDeepSearch={onOpenDeepSearch}
            />
          </div>
          <button
            type="button"
            onClick={showSqlEditor ? onCloseSqlEditor : onOpenSqlEditor}
            aria-pressed={showSqlEditor}
            className={
              'flex w-full shrink-0 items-center justify-center gap-2 px-3 py-2 text-[12px] font-semibold text-white shadow-sm transition-colors ' +
              (showSqlEditor
                ? 'bg-blue-600 hover:bg-blue-500'
                : 'bg-emerald-600 hover:bg-emerald-500')
            }
            title={showSqlEditor ? 'Close full SQL editor' : 'Open full SQL editor'}
          >
            <SqlEditorIcon className="h-3.5 w-3.5" />
            SQL Editor
          </button>
        </div>
      )}
      {showAbout ? (
        <AboutPage version={appVersion} onClose={onCloseAbout} backLabel="Back to session" />
      ) : showPlugins ? (
        <PluginsPage plugins={plugins} onClose={onClosePlugins} backLabel="Back to session" />
      ) : showSettings ? (
        <SettingsPage onClose={onCloseSettings} backLabel="Back to session" />
      ) : showSqlEditor ? (
        <SqlEditorPage
          sql={tab.sql}
          onSqlChange={onSqlChange}
          schema={tab.schema}
          busy={tab.busy}
          onExecute={() => onExecute()}
          bookmarks={tab.bookmarks}
          onBookmarksChange={onBookmarksChange}
          results={tab.results}
          schemaForResults={tab.schema}
          tabId={tab.id}
          sessionId={tab.sessionId}
          columnWidths={tab.columnWidths}
          onColumnWidthsChange={onColumnWidthsChange}
          onCommitCellEdit={onCommitCellEdit}
          onApplyFilter={onApplyFilter}
          onFetchBlob={onFetchBlob}
          onCountAllRows={onCountAllRows}
          onFetchScopedRows={onFetchScopedRows}
          onClose={onCloseSqlEditor}
        />
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
        <main className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6 pt-0">
          <QueryPanel
            transactionBar={
              <TransactionBar
                status={tab.txStatus}
                busy={tab.busy}
                onSetMode={onSetTxMode}
                onCommit={onCommitTx}
                onRollback={onRollbackTx}
              />
            }
            sessionId={tab.sessionId}
            sql={tab.sql}
            busy={tab.busy}
            cryptState={tab.cryptState}
            schema={tab.schema}
            bookmarks={tab.bookmarks}
            health={tab.health}
            engineVersion={tab.engineVersion}
            encryptionKeySupplied={tab.form.encryptionKey.length > 0}
            lastResultSummary={summariseResults(tab.results)}
            onSqlChange={onSqlChange}
            onExecute={onExecute}
            onClose={onDisconnect}
            onBookmarksChange={onBookmarksChange}
            onOpenStats={onOpenStats}
            onReconnect={onReconnect}
            onEditorFocus={() => emitEditorFocused({ tabId: tab.id, focusedAt: Date.now() })}
            onEditorSelectionChange={(sel) =>
              emitEditorSelectionChanged({
                tabId: tab.id,
                anchor: sel.anchor,
                head: sel.head,
                length: sel.head - sel.anchor,
                changedAt: Date.now(),
              })
            }
          />

          {tab.error && <ErrorBanner error={tab.error} onDismiss={onClearError} />}

          {(() => {
            if (tab.focusedRoutine) {
              return (
                <RoutineObjectView
                  kind={tab.focusedRoutine.kind}
                  name={tab.focusedRoutine.name}
                  source={tab.focusedRoutine.source}
                  loading={tab.focusedRoutine.loading}
                  error={tab.focusedRoutine.error}
                  onClose={onCloseFocusedRoutine}
                  onOpenInEditor={(sql) => onSqlChange(sql)}
                />
              );
            }
            const focusedTable =
              tab.focusedObjectName && tab.schema
                ? (tab.schema.tables.find((t) => t.name === tab.focusedObjectName) ?? null)
                : null;
            if (focusedTable && tab.results && tab.results.length > 0) {
              return (
                <TableObjectView
                  tabId={tab.id}
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
                  tabId={tab.id}
                  sessionId={tab.sessionId}
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
              stats={stats}
              onRefreshStats={onRefreshStats}
              onComputeRowCounts={onComputeRowCounts}
              onRefreshSchema={onRefreshSchema}
              onNewQuery={() => onSqlChange('')}
              embedded={tab.form.embedded}
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
