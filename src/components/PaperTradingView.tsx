import React, { useState, useEffect } from 'react';
import { Play, Square, Wallet, TrendingUp, History, AlertCircle, Target } from 'lucide-react';

export default function PaperTradingView() {
  const [isRunning, setIsRunning] = useState(false);
  const [wallet, setWallet] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [monitoring, setMonitoring] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      const [statusRes, walletRes, posRes, histRes, monitorRes] = await Promise.all([
        fetch('/api/paper/status'),
        fetch('/api/paper/wallet'),
        fetch('/api/paper/positions'),
        fetch('/api/paper/history'),
        fetch('/api/paper/monitoring')
      ]);

      const status = await statusRes.json();
      const walletData = await walletRes.json();
      const posData = await posRes.json();
      const histData = await histRes.json();
      const monitorData = await monitorRes.json();

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

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Wallet Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                    No symbols being monitored. Ensure you have "Approved Settings".
                  </td>
                </tr>
              ) : (
                monitoring.map((m) => (
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
                        {m.trend}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-300">${m.currentPrice?.toFixed(4)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full animate-pulse ${
                          m.plan.includes('Waiting') ? 'bg-yellow-500' : 'bg-blue-500'
                        }`} />
                        <span className="text-slate-200">{m.plan}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {new Date(m.updatedAt).toLocaleTimeString()}
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
                positions.map((pos) => (
                  <tr key={pos.id} className="border-b border-slate-700/50 last:border-0">
                    <td className="px-4 py-3 font-medium text-white">{pos.symbol}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        pos.side === 'LONG' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'
                      }`}>
                        {pos.side}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{pos.size?.toFixed(4)}</td>
                    <td className="px-4 py-3 text-slate-300">${pos.entryPrice?.toFixed(4)}</td>
                    <td className={`px-4 py-3 font-medium ${
                      pos.unrealizedPnl >= 0 ? 'text-emerald-500' : 'text-red-500'
                    }`}>
                      {pos.unrealizedPnl >= 0 ? '+' : ''}{pos.unrealizedPnl?.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {new Date(pos.openedAt).toLocaleString()}
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
                history.map((trade) => (
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
                      ${trade.entryPrice?.toFixed(4)} / ${trade.exitPrice?.toFixed(4)}
                    </td>
                    <td className={`px-4 py-3 font-medium ${
                      trade.pnl >= 0 ? 'text-emerald-500' : 'text-red-500'
                    }`}>
                      {trade.pnl >= 0 ? '+' : ''}{trade.pnl?.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-slate-400">{trade.reason}</td>
                    <td className="px-4 py-3 text-slate-400">
                      {new Date(trade.closedAt).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
