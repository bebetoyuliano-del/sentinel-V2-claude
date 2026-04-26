import React, { useState, useEffect } from 'react';
import { Play, Square, Wallet, TrendingUp, History, AlertCircle, Target, Loader2, AlertTriangle, Download } from 'lucide-react';

export default function PaperTradingView() {
  const [isRunning, setIsRunning] = useState(false);
  const [wallet, setWallet] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [monitoring, setMonitoring] = useState<any[]>([]);
  const [decisions, setDecisions] = useState<any[]>([]);
  const [sessionSummary, setSessionSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isImportingLive, setIsImportingLive] = useState(false);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);

  const fetchData = async () => {
    try {
      const [statusRes, walletRes, posRes, histRes, monitorRes, decisionsRes, summaryRes] = await Promise.all([
        fetch('/api/paper/status'),
        fetch('/api/paper/wallet'),
        fetch('/api/paper/positions'),
        fetch('/api/paper/history'),
        fetch('/api/paper/monitoring'),
        fetch('/api/paper/decisions'),
        fetch('/api/paper/session-review')
      ]);

      const status = await statusRes.json();
      const walletData = await walletRes.json();
      const posData = await posRes.json();
      const histData = await histRes.json();
      const monitorData = await monitorRes.json();
      const decisionsData = await decisionsRes.json();
      const summaryData = await summaryRes.json();

      if (!statusRes.ok) throw new Error(status.error || 'Failed to fetch status');
      if (!walletRes.ok) throw new Error(walletData.error || 'Failed to fetch wallet');
      if (!posRes.ok) throw new Error(posData.error || 'Failed to fetch positions');
      if (!histRes.ok) throw new Error(histData.error || 'Failed to fetch history');
      if (!monitorRes.ok) throw new Error(monitorData.error || 'Failed to fetch monitoring');

      setIsRunning(status.isPaperTradingRunning);
      setWallet(walletData);
      setPositions(Array.isArray(posData) ? posData : []);
      setHistory(Array.isArray(histData) ? histData.sort((a: any, b: any) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime()) : []);
      setMonitoring(Array.isArray(monitorData) ? monitorData : []);
      setDecisions(Array.isArray(decisionsData) ? decisionsData : []);
      setSessionSummary(summaryData);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, []);

  const toggleEngine = async () => {
    try {
      const res = await fetch('/api/paper/toggle', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to toggle engine');
      setIsRunning(data.isPaperTradingRunning);
      fetchData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleReset = async () => {
    if (!showResetConfirm) {
      setShowResetConfirm(true);
      setTimeout(() => setShowResetConfirm(false), 3000); // Reset after 3 seconds if not confirmed
      return;
    }

    setIsResetting(true);
    try {
      const res = await fetch('/api/paper/reset', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reset account');
      await fetchData();
      setShowResetConfirm(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsResetting(false);
    }
  };

  const handleImportLive = async () => {
    if (!showImportConfirm) {
      setShowImportConfirm(true);
      setTimeout(() => setShowImportConfirm(false), 4000);
      return;
    }
    setIsImportingLive(true);
    setImportResult(null);
    try {
      const res = await fetch('/api/paper/import-live', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to import live data');
      setImportResult(data);
      await fetchData();
      setShowImportConfirm(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsImportingLive(false);
    }
  };

  const [activeTab, setActiveTab] = useState<'overview' | 'decisions' | 'review'>('overview');
  const [selectedDecision, setSelectedDecision] = useState<any>(null);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-slate-400">Loading paper trading data...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-white">Paper Trading</h2>
          <p className="text-slate-400 text-sm">Virtual trading environment using live market data</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleImportLive}
            disabled={isImportingLive}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
              showImportConfirm
                ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
                : 'bg-slate-700/50 text-slate-300 hover:bg-slate-700'
            } ${isImportingLive ? 'opacity-50 cursor-not-allowed' : ''}`}
            title="Import posisi dan wallet live Binance ke paper trading"
          >
            {isImportingLive ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Importing...</>
            ) : showImportConfirm ? (
              <><AlertTriangle className="w-4 h-4" /> Confirm Import</>
            ) : (
              <><Download className="w-4 h-4" /> Import Live</>
            )}
          </button>
          <button
            onClick={handleReset}
            disabled={isResetting}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
              showResetConfirm
                ? 'bg-red-500/20 text-red-500 hover:bg-red-500/30'
                : 'bg-slate-700/50 text-slate-300 hover:bg-slate-700'
            } ${isResetting ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {isResetting ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Resetting...</>
            ) : showResetConfirm ? (
              <><AlertTriangle className="w-4 h-4" /> Confirm Reset</>
            ) : (
              <>Reset Account</>
            )}
          </button>
          <button
            onClick={toggleEngine}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
              isRunning 
                ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20' 
                : 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20'
            }`}
          >
            {isRunning ? (
              <><Square className="w-4 h-4" /> Stop Engine</>
            ) : (
              <><Play className="w-4 h-4" /> Start Engine</>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {importResult && (
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
          <p className="text-blue-400 font-semibold mb-1">✅ Live Import Berhasil</p>
          <p className="text-slate-300 text-sm">
            <b>{importResult.positionsImported}</b> posisi diimport dari Binance &nbsp;|&nbsp;
            Wallet: <b>${importResult.walletBalance?.toFixed(2)}</b> &nbsp;|&nbsp;
            Equity: <b>${importResult.equity?.toFixed(2)}</b> &nbsp;|&nbsp;
            Pairs: <b>{importResult.pairs?.length}</b>
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-4 border-b border-slate-700/50 pb-2">
        <button
          onClick={() => setActiveTab('overview')}
          className={`px-4 py-2 font-medium text-sm rounded-lg transition-colors ${
            activeTab === 'overview' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab('decisions')}
          className={`px-4 py-2 font-medium text-sm rounded-lg transition-colors ${
            activeTab === 'decisions' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Parity Decisions
        </button>
        <button
          onClick={() => setActiveTab('review')}
          className={`px-4 py-2 font-medium text-sm rounded-lg transition-colors ${
            activeTab === 'review' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Session Review
        </button>
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Wallet Stats */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-slate-400 mb-2">
            <Wallet className="w-4 h-4" />
            <span className="text-sm font-medium">Balance</span>
          </div>
          <div className="text-2xl font-bold text-white">
            ${wallet?.balance?.toFixed(2) || '0.00'}
          </div>
        </div>
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-slate-400 mb-2">
            <TrendingUp className="w-4 h-4" />
            <span className="text-sm font-medium">Equity</span>
          </div>
          <div className="text-2xl font-bold text-white">
            ${wallet?.equity?.toFixed(2) || '0.00'}
          </div>
        </div>
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-slate-400 mb-2">
            <Wallet className="w-4 h-4" />
            <span className="text-sm font-medium">Free Margin</span>
          </div>
          <div className="text-2xl font-bold text-white">
            ${wallet?.freeMargin?.toFixed(2) || '0.00'}
          </div>
        </div>
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-slate-400 mb-2">
            <AlertCircle className="w-4 h-4" />
            <span className="text-sm font-medium">Margin Ratio</span>
          </div>
          <div className={`text-2xl font-bold ${
            (wallet?.marginRatio || 0) > 25 ? 'text-red-400' : 
            (wallet?.marginRatio || 0) > 15 ? 'text-amber-400' : 'text-emerald-400'
          }`}>
            {wallet?.marginRatio?.toFixed(2) || '0.00'}%
          </div>
        </div>
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-slate-400 mb-2">
            <Target className="w-4 h-4" />
            <span className="text-sm font-medium">Leverage</span>
          </div>
          <div className="text-2xl font-bold text-emerald-400">
            20x
          </div>
        </div>
      </div>

      {/* Strategy Monitoring & Plans */}
      <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-700/50 flex items-center gap-2">
          <Target className="w-5 h-5 text-emerald-400" />
          <h3 className="font-semibold text-white">Sentinel Strategy Plan (Monitoring)</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-slate-400 uppercase bg-slate-900/50">
              <tr>
                <th className="px-4 py-3">Symbol</th>
                <th className="px-4 py-3">Trend</th>
                <th className="px-4 py-3">Price</th>
                <th className="px-4 py-3">Sentinel Plan / Next Action</th>
                <th className="px-4 py-3">Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {monitoring.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    No symbols being monitored. Waiting for AI signals or open positions.
                  </td>
                </tr>
              ) : (
                monitoring.filter(m => m.symbol).map((m) => (
                  <tr key={m.id} className="border-b border-slate-700/50 last:border-0">
                    <td className="px-4 py-3 font-medium text-white">
                      <div className="flex flex-col">
                        <span>{m.symbol}</span>
                        <span className="text-[10px] text-slate-500">{m.timeframe}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        m.trend === 'UP' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'
                      }`}>
                        {m.trend || 'N/A'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-300">${m.currentPrice?.toFixed(4) || '0.0000'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full animate-pulse ${
                          m.plan?.includes('Waiting') ? 'bg-yellow-500' : 'bg-blue-500'
                        }`} />
                        <span className="text-slate-200">{m.plan || 'N/A'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {m.updatedAt ? new Date(m.updatedAt).toLocaleTimeString() : 'N/A'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Open Positions */}
      <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-700/50 flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-blue-400" />
          <h3 className="font-semibold text-white">Open Positions ({positions.length})</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-slate-400 uppercase bg-slate-900/50">
              <tr>
                <th className="px-4 py-3">Symbol</th>
                <th className="px-4 py-3">Side</th>
                <th className="px-4 py-3">Size</th>
                <th className="px-4 py-3">Entry Price</th>
                <th className="px-4 py-3">Unrealized PnL</th>
                <th className="px-4 py-3">Opened At</th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    No open positions
                  </td>
                </tr>
              ) : (
                positions.filter(pos => pos.symbol).map((pos) => (
                  <tr key={pos.id} className="border-b border-slate-700/50 last:border-0">
                    <td className="px-4 py-3 font-medium text-white">{pos.symbol}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        pos.side === 'LONG' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'
                      }`}>
                        {pos.side}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{pos.size?.toFixed(4) || '0.0000'}</td>
                    <td className="px-4 py-3 text-slate-300">${pos.entryPrice?.toFixed(4) || '0.0000'}</td>
                    <td className={`px-4 py-3 font-medium ${
                      (pos.unrealizedPnl || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'
                    }`}>
                      {(pos.unrealizedPnl || 0) >= 0 ? '+' : ''}{(pos.unrealizedPnl || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {pos.openedAt ? new Date(pos.openedAt).toLocaleString() : 'N/A'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Trade History */}
      <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-700/50 flex items-center gap-2">
          <History className="w-5 h-5 text-purple-400" />
          <h3 className="font-semibold text-white">Trade History</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-slate-400 uppercase bg-slate-900/50">
              <tr>
                <th className="px-4 py-3">Symbol</th>
                <th className="px-4 py-3">Side</th>
                <th className="px-4 py-3">Entry / Exit</th>
                <th className="px-4 py-3">PnL</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Closed At</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    No trade history yet
                  </td>
                </tr>
              ) : (
                history.filter(trade => trade.symbol).map((trade) => (
                  <tr key={trade.id} className="border-b border-slate-700/50 last:border-0">
                    <td className="px-4 py-3 font-medium text-white">{trade.symbol}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        trade.side === 'LONG' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'
                      }`}>
                        {trade.side}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      ${trade.entryPrice?.toFixed(4) || '0.0000'} / ${trade.exitPrice?.toFixed(4) || '0.0000'}
                    </td>
                    <td className={`px-4 py-3 font-medium ${
                      (trade.pnl || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'
                    }`}>
                      {(trade.pnl || 0) >= 0 ? '+' : ''}{(trade.pnl || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-slate-400">{trade.reason}</td>
                    <td className="px-4 py-3 text-slate-400">
                      {trade.closedAt ? new Date(trade.closedAt).toLocaleString() : 'N/A'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      </div>
      )}

      {activeTab === 'decisions' && (
        <div className="space-y-6">
          <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-700/50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Target className="w-5 h-5 text-blue-400" />
                <h3 className="font-semibold text-white">Parity Decisions Feed</h3>
              </div>
              <div className="text-xs text-slate-400">
                Total: {decisions.length} | Executed: {decisions.filter(d => d.executionResult === 'EXECUTED').length} | Blocked: {decisions.filter(d => d.why_blocked).length}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-400 uppercase bg-slate-900/50">
                  <tr>
                    <th className="px-4 py-3">Time</th>
                    <th className="px-4 py-3">Symbol</th>
                    <th className="px-4 py-3">Context</th>
                    <th className="px-4 py-3">Requested</th>
                    <th className="px-4 py-3">Final Action</th>
                    <th className="px-4 py-3">Result</th>
                    <th className="px-4 py-3">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                        {sessionSummary?.sessionMetadata?.engineStatus === 'RUNNING' ? (
                          <div className="flex flex-col items-center gap-2">
                            <div className="flex items-center gap-2 text-emerald-400">
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span>Engine is running...</span>
                            </div>
                            <div className="text-xs text-slate-400">
                              Last Tick: {sessionSummary?.sessionMetadata?.lastTick ? new Date(sessionSummary.sessionMetadata.lastTick).toLocaleTimeString() : 'Waiting...'}
                            </div>
                            <div className="text-xs text-slate-500">
                              {sessionSummary?.sessionMetadata?.lastSkipReason || 'Waiting for first cycle'}
                            </div>
                          </div>
                        ) : (
                          'No parity decisions recorded yet'
                        )}
                      </td>
                    </tr>
                  ) : (
                    decisions.map((d, i) => (
                      <tr 
                        key={i} 
                        onClick={() => setSelectedDecision(d)}
                        className="border-b border-slate-700/50 last:border-0 hover:bg-slate-800/30 cursor-pointer"
                      >
                        <td className="px-4 py-3 text-slate-400 text-xs">
                          {new Date(d.ts).toLocaleTimeString()}
                        </td>
                        <td className="px-4 py-3 font-medium text-white">{d.symbol}</td>
                        <td className="px-4 py-3 text-xs">
                          <div className="text-slate-300">Mode: {d.ContextMode}</div>
                          <div className="text-slate-500">Struct: {d.Structure}</div>
                        </td>
                        <td className="px-4 py-3 text-slate-300">{d.requested_action}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-1 rounded text-xs font-medium ${
                            d.final_action.includes('LONG') ? 'bg-emerald-500/10 text-emerald-500' : 
                            d.final_action.includes('SHORT') ? 'bg-red-500/10 text-red-500' : 
                            'bg-slate-500/10 text-slate-400'
                          }`}>
                            {d.final_action}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-1 rounded text-xs font-medium ${
                            d.executionResult === 'EXECUTED' ? 'bg-emerald-500/10 text-emerald-500' : 
                            d.executionResult === 'BLOCKED' ? 'bg-red-500/10 text-red-500' : 
                            'bg-slate-500/10 text-slate-400'
                          }`}>
                            {d.executionResult}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-400 max-w-xs truncate" title={d.why_blocked || d.why_allowed || '-'}>
                          {d.why_blocked || d.why_allowed || '-'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'review' && sessionSummary && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Session Metadata</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-slate-400">Mode:</span> <span className="text-white">{sessionSummary.sessionMetadata.mode}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Paper Engine Mode:</span> <span className="text-white">{sessionSummary.sessionMetadata.paperEngineMode}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Engine Status:</span> <span className={sessionSummary.sessionMetadata.engineStatus === 'RUNNING' ? 'text-emerald-400' : 'text-slate-400'}>{sessionSummary.sessionMetadata.engineStatus}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Session Start:</span> <span className="text-white">{sessionSummary.sessionMetadata.sessionStart ? new Date(sessionSummary.sessionMetadata.sessionStart).toLocaleString() : 'N/A'}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Last Tick:</span> <span className="text-white">{sessionSummary.sessionMetadata.lastTick ? new Date(sessionSummary.sessionMetadata.lastTick).toLocaleString() : 'N/A'}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Last Decision At:</span> <span className="text-white">{sessionSummary.sessionMetadata.lastDecisionAt ? new Date(sessionSummary.sessionMetadata.lastDecisionAt).toLocaleString() : 'N/A'}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Last Skip Reason:</span> <span className="text-slate-300 truncate max-w-[200px]" title={sessionSummary.sessionMetadata.lastSkipReason || 'N/A'}>{sessionSummary.sessionMetadata.lastSkipReason || 'N/A'}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Scope Safety:</span> <span className="text-emerald-400">{sessionSummary.scopeSafetySummary}</span></div>
              </div>
            </div>
            
            <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Runtime Action Counts</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-slate-400">Total Decisions:</span> <span className="text-white">{sessionSummary.runtimeActionCounts.total}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Executed:</span> <span className="text-emerald-400">{sessionSummary.runtimeActionCounts.executed}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Skipped (Decisions):</span> <span className="text-slate-300">{sessionSummary.runtimeActionCounts.skipped}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Blocked:</span> <span className="text-red-400">{sessionSummary.runtimeActionCounts.blocked}</span></div>
                <div className="my-2 border-t border-slate-700/50"></div>
                <div className="flex justify-between"><span className="text-slate-400">Skipped Cycles:</span> <span className="text-yellow-400">{sessionSummary.runtimeActionCounts.skippedCycles || 0}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">No-Signal Cycles:</span> <span className="text-slate-400">{sessionSummary.runtimeActionCounts.noSignalCycles || 0}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">No-Position Cycles:</span> <span className="text-slate-400">{sessionSummary.runtimeActionCounts.noPositionCycles || 0}</span></div>
              </div>
            </div>
            
            <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Guardrail Blocks</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-slate-400">Margin Ratio (MR):</span> <span className="text-yellow-400">{sessionSummary.blockCounts.mr}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Ambiguity:</span> <span className="text-yellow-400">{sessionSummary.blockCounts.ambiguity}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Chop / Recovery Suspended:</span> <span className="text-yellow-400">{sessionSummary.blockCounts.chop}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Golden Rule:</span> <span className="text-yellow-400">{sessionSummary.blockCounts.goldenRule}</span></div>
              </div>
            </div>
            
            <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Degraded Mode Stats</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-slate-400">Firestore Available:</span> <span className={sessionSummary.degradedModeStats.firestoreAvailable ? 'text-emerald-400' : 'text-red-400'}>{sessionSummary.degradedModeStats.firestoreAvailable ? 'YES' : 'NO'}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Degraded Mode Active:</span> <span className={sessionSummary.degradedModeStats.degradedModeActive ? 'text-yellow-400' : 'text-slate-400'}>{sessionSummary.degradedModeStats.degradedModeActive ? 'YES' : 'NO'}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Cooldown Until:</span> <span className="text-white">{sessionSummary.degradedModeStats.cooldownUntil ? new Date(sessionSummary.degradedModeStats.cooldownUntil).toLocaleString() : 'N/A'}</span></div>
              </div>
            </div>

            <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Export</h3>
              <p className="text-sm text-slate-400 mb-4">Export this session summary to fill out your review template.</p>
              <div className="flex gap-2">
                <button 
                  onClick={() => {
                    const blob = new Blob([JSON.stringify(sessionSummary, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `session-review-${new Date().toISOString().split('T')[0]}.json`;
                    a.click();
                  }}
                  className="px-4 py-2 bg-blue-500/20 text-blue-400 rounded-lg text-sm hover:bg-blue-500/30 transition-colors"
                >
                  Export JSON
                </button>
                <button 
                  onClick={() => {
                    const md = `
# Paper Trading Session Review
**Date:** ${new Date().toISOString().split('T')[0]}
**Mode:** ${sessionSummary.sessionMetadata.mode}
**Paper Engine Mode:** ${sessionSummary.sessionMetadata.paperEngineMode}
**Engine Status:** ${sessionSummary.sessionMetadata.engineStatus}
**Session Start:** ${sessionSummary.sessionMetadata.sessionStart ? new Date(sessionSummary.sessionMetadata.sessionStart).toLocaleString() : 'N/A'}
**Last Tick:** ${sessionSummary.sessionMetadata.lastTick ? new Date(sessionSummary.sessionMetadata.lastTick).toLocaleString() : 'N/A'}
**Last Decision At:** ${sessionSummary.sessionMetadata.lastDecisionAt ? new Date(sessionSummary.sessionMetadata.lastDecisionAt).toLocaleString() : 'N/A'}
**Last Skip Reason:** ${sessionSummary.sessionMetadata.lastSkipReason || 'N/A'}

## Runtime Action Counts
- Total Decisions: ${sessionSummary.runtimeActionCounts.total}
- Executed: ${sessionSummary.runtimeActionCounts.executed}
- Skipped (Decisions): ${sessionSummary.runtimeActionCounts.skipped}
- Blocked: ${sessionSummary.runtimeActionCounts.blocked}
- Skipped Cycles: ${sessionSummary.runtimeActionCounts.skippedCycles}
- No-Signal Cycles: ${sessionSummary.runtimeActionCounts.noSignalCycles}
- No-Position Cycles: ${sessionSummary.runtimeActionCounts.noPositionCycles}

## Guardrail Blocks
- Margin Ratio (MR): ${sessionSummary.blockCounts.mr}
- Ambiguity: ${sessionSummary.blockCounts.ambiguity}
- Chop / Recovery Suspended: ${sessionSummary.blockCounts.chop}
- Golden Rule: ${sessionSummary.blockCounts.goldenRule}

## Degraded Mode Stats
- Firestore Available: ${sessionSummary.degradedModeStats.firestoreAvailable ? 'YES' : 'NO'}
- Degraded Mode Active: ${sessionSummary.degradedModeStats.degradedModeActive ? 'YES' : 'NO'}
- Cooldown Until: ${sessionSummary.degradedModeStats.cooldownUntil ? new Date(sessionSummary.degradedModeStats.cooldownUntil).toLocaleString() : 'N/A'}

## Scope Safety
${sessionSummary.scopeSafetySummary}
                    `.trim();
                    const blob = new Blob([md], { type: 'text/markdown' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `session-review-${new Date().toISOString().split('T')[0]}.md`;
                    a.click();
                  }}
                  className="px-4 py-2 bg-purple-500/20 text-purple-400 rounded-lg text-sm hover:bg-purple-500/30 transition-colors"
                >
                  Export Markdown
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Pair Detail Inspector Modal */}
      {selectedDecision && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-4 border-b border-slate-700 flex justify-between items-center sticky top-0 bg-slate-900">
              <h3 className="text-lg font-bold text-white">Decision Inspector: {selectedDecision.symbol}</h3>
              <button 
                onClick={() => setSelectedDecision(null)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="p-6 space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-slate-500 mb-1">Timestamp</div>
                  <div className="text-sm text-white">{new Date(selectedDecision.ts).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Price</div>
                  <div className="text-sm text-white">${selectedDecision.price}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Primary Trend 4H</div>
                  <div className="text-sm text-white">{selectedDecision.PrimaryTrend4H}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Trend Status</div>
                  <div className="text-sm text-white">{selectedDecision.TrendStatus}</div>
                </div>
              </div>

              <div className="border-t border-slate-700 pt-4">
                <h4 className="text-sm font-semibold text-slate-300 mb-3">Position Context</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Structure</div>
                    <div className="text-sm text-white">{selectedDecision.Structure}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Context Mode</div>
                    <div className="text-sm text-white">{selectedDecision.ContextMode}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Green Leg</div>
                    <div className="text-sm text-white">{selectedDecision.GreenLeg}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Red Leg</div>
                    <div className="text-sm text-white">{selectedDecision.RedLeg}</div>
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-700 pt-4">
                <h4 className="text-sm font-semibold text-slate-300 mb-3">Decision Outcome</h4>
                <div className="space-y-3">
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Requested Action</div>
                    <div className="text-sm text-white">{selectedDecision.requested_action}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Final Action</div>
                    <div className={`text-sm font-medium ${
                      selectedDecision.final_action.includes('LONG') ? 'text-emerald-400' : 
                      selectedDecision.final_action.includes('SHORT') ? 'text-red-400' : 'text-slate-300'
                    }`}>
                      {selectedDecision.final_action}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Execution Result</div>
                    <div className={`text-sm font-medium ${
                      selectedDecision.executionResult === 'EXECUTED' ? 'text-emerald-400' : 
                      selectedDecision.executionResult === 'BLOCKED' ? 'text-red-400' : 'text-slate-300'
                    }`}>
                      {selectedDecision.executionResult}
                    </div>
                  </div>
                  {selectedDecision.why_blocked && (
                    <div className="bg-red-500/10 border border-red-500/20 rounded p-3">
                      <div className="text-xs text-red-500 mb-1">Block Reason</div>
                      <div className="text-sm text-red-400">{selectedDecision.why_blocked}</div>
                    </div>
                  )}
                  {selectedDecision.why_allowed && (
                    <div className="bg-emerald-500/10 border border-emerald-500/20 rounded p-3">
                      <div className="text-xs text-emerald-500 mb-1">Allow Reason</div>
                      <div className="text-sm text-emerald-400">{selectedDecision.why_allowed}</div>
                    </div>
                  )}
                </div>
              </div>
              
              <div className="border-t border-slate-700 pt-4">
                <h4 className="text-sm font-semibold text-slate-300 mb-3">Risk & Flags</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Projected MR</div>
                    <div className="text-sm text-white">{selectedDecision.MRProjected?.toFixed(2)}%</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Recovery Suspended</div>
                    <div className="text-sm text-white">{selectedDecision.recovery_suspended ? 'YES' : 'NO'}</div>
                  </div>
                  <div className="col-span-2">
                    <div className="text-xs text-slate-500 mb-1">Ambiguity Flags</div>
                    <div className="flex flex-wrap gap-2">
                      {selectedDecision.ambiguity_flags?.length > 0 ? (
                        selectedDecision.ambiguity_flags.map((flag: string, i: number) => (
                          <span key={i} className="px-2 py-1 bg-yellow-500/10 text-yellow-500 text-xs rounded">
                            {flag}
                          </span>
                        ))
                      ) : (
                        <span className="text-sm text-slate-400">None</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
