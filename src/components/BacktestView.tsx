import React, { useState } from 'react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area 
} from 'recharts';
import { Play, TrendingUp, TrendingDown, History, BarChart2, AlertCircle, CheckCircle2, Loader2, RefreshCw, Brain } from 'lucide-react';
import Markdown from 'react-markdown';

interface BacktestResult {
  symbol: string;
  timeframe: string;
  days: number;
  summary: {
    initialBalance: number;
    finalBalance: number;
    totalProfit: number;
    profitPct: number;
    totalTrades: number;
    winRate: number;
    maxDrawdown: number;
  };
  trades: {
    type: string;
    entryPrice: number;
    entryTime: number;
    exitPrice: number;
    exitTime: number;
    exitReason: string;
    isHedged: boolean;
    hedgeCount: number;
    profit: number;
    profitPct: number;
    finalBalance: number;
  }[];
  equityCurve: any[];
}

const BacktestView: React.FC = () => {
  const [symbol, setSymbol] = useState('BTC/USDT');
  const [timeframe, setTimeframe] = useState('1h');
  const [days, setDays] = useState<number | string>(7);
  const [takeProfitPct, setTakeProfitPct] = useState<number | string>(4);
  const [lock11Mode, setLock11Mode] = useState(true);
  const [lockTriggerPct, setLockTriggerPct] = useState<number | string>(2.0);
  const [add05Mode, setAdd05Mode] = useState(true);
  const [structure21Mode, setStructure21Mode] = useState(false);
  const [maxMrPct, setMaxMrPct] = useState<number | string>(25.0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const runBacktest = async () => {
    setLoading(true);
    setError(null);
    setAiAnalysis(null);
    setSaveSuccess(false);
    try {
      const response = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          symbol, 
          timeframe, 
          days, 
          takeProfitPct, 
          lock11Mode, 
          lockTriggerPct,
          add05Mode,
          structure21Mode,
          maxMrPct
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      setResult(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const optimizeWithAI = async () => {
    if (!result) return;
    setAnalyzing(true);
    setAiAnalysis(null);
    try {
      const response = await fetch('/api/ai/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backtestResult: result })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      setAiAnalysis(data.analysis);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const saveApprovedSettings = async () => {
    if (!result) return;
    setSavingSettings(true);
    setSaveSuccess(false);
    try {
      const response = await fetch('/api/backtest/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          symbol, 
          timeframe, 
          days, 
          takeProfitPct, 
          lock11Mode, 
          lockTriggerPct,
          add05Mode,
          structure21Mode,
          maxMrPct,
          summary: result.summary
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingSettings(false);
    }
  };

  const formatTime = (ms: number) => {
    return new Date(ms).toLocaleString('id-ID', { 
      month: 'short', 
      day: 'numeric', 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  return (
    <div className="space-y-6">
      {/* Configuration Header */}
      <div className="bg-zinc-900/50 border border-white/10 rounded-2xl p-6 mb-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-6">
          {/* Symbol & Timeframe */}
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest ml-1">Symbol</label>
            <input 
              type="text" 
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-emerald-500/50 transition-all"
              placeholder="BTC/USDT"
            />
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest ml-1">Timeframe</label>
            <select 
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-emerald-500/50 transition-all appearance-none"
            >
              {['1m', '5m', '15m', '1h', '4h', '1d'].map(tf => (
                <option key={tf} value={tf}>{tf}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest ml-1">Duration (Days)</label>
            <input 
              type="number" 
              value={days}
              onChange={(e) => setDays(e.target.value === '' ? '' : parseInt(e.target.value))}
              className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-emerald-500/50 transition-all"
            />
          </div>

          {/* Risk Management */}
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest ml-1">Take Profit (%)</label>
            <input 
              type="number" 
              step="0.1"
              value={takeProfitPct}
              onChange={(e) => setTakeProfitPct(e.target.value === '' ? '' : parseFloat(e.target.value))}
              className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-emerald-500/50 transition-all"
            />
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest ml-1">Max MR (%)</label>
            <input 
              type="number" 
              step="0.1"
              value={maxMrPct}
              onChange={(e) => setMaxMrPct(e.target.value === '' ? '' : parseFloat(e.target.value))}
              className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-emerald-500/50 transition-all"
            />
          </div>

          {/* SOP Settings Group */}
          <div className="lg:col-span-2 xl:col-span-4 bg-white/5 border border-white/10 rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest ml-1">Lock 1:1 Mode</label>
              <button
                onClick={() => setLock11Mode(!lock11Mode)}
                className={`w-full py-3 rounded-xl border transition-all text-[10px] font-bold ${
                  lock11Mode 
                    ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-400' 
                    : 'bg-zinc-800/50 border-white/5 text-zinc-500'
                }`}
              >
                {lock11Mode ? 'ENABLED' : 'DISABLED'}
              </button>
            </div>

            {lock11Mode && (
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-indigo-400/70 uppercase tracking-widest ml-1">Lock Trigger (%)</label>
                <input 
                  type="number" 
                  step="0.1"
                  value={lockTriggerPct}
                  onChange={(e) => setLockTriggerPct(e.target.value === '' ? '' : parseFloat(e.target.value))}
                  className="w-full bg-black border border-indigo-500/30 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-indigo-500/50 transition-all"
                />
              </div>
            )}

            <div className="space-y-2">
              <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest ml-1">Add 0.5 Mode</label>
              <button
                onClick={() => setAdd05Mode(!add05Mode)}
                className={`w-full py-3 rounded-xl border transition-all text-[10px] font-bold ${
                  add05Mode 
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' 
                    : 'bg-zinc-800/50 border-white/5 text-zinc-500'
                }`}
              >
                {add05Mode ? 'ENABLED' : 'DISABLED'}
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest ml-1">Structure 2:1</label>
              <button
                onClick={() => setStructure21Mode(!structure21Mode)}
                className={`w-full py-3 rounded-xl border transition-all text-[10px] font-bold ${
                  structure21Mode 
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-400' 
                    : 'bg-zinc-800/50 border-white/5 text-zinc-500'
                }`}
              >
                {structure21Mode ? 'ENABLED' : 'DISABLED'}
              </button>
            </div>
          </div>

          {/* Action Button */}
          <div className="flex items-end">
            <button 
              onClick={runBacktest}
              disabled={loading}
              className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-500 text-zinc-950 font-bold py-4 rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20"
            >
              {loading ? (
                <RefreshCw className="w-5 h-5 animate-spin" />
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current" />
                  Run Backtest
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3 text-red-400">
          <AlertCircle className="w-5 h-5" />
          <p className="text-sm font-medium">{error}</p>
        </div>
      )}

      {result && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-zinc-900/50 border border-white/10 rounded-2xl p-5 space-y-1">
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Total Profit</p>
              <div className="flex items-baseline gap-2">
                <h3 className={`text-2xl font-bold ${result.summary.totalProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {result.summary.totalProfit >= 0 ? '+' : ''}{result.summary.profitPct.toFixed(2)}%
                </h3>
                <span className="text-xs text-zinc-500">${result.summary.totalProfit.toFixed(2)}</span>
              </div>
            </div>
            <div className="bg-zinc-900/50 border border-white/10 rounded-2xl p-5 space-y-1">
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Win Rate</p>
              <h3 className="text-2xl font-bold text-white">{result.summary.winRate.toFixed(1)}%</h3>
              <p className="text-xs text-zinc-500">{result.summary.totalTrades} Total Trades</p>
            </div>
            <div className="bg-zinc-900/50 border border-white/10 rounded-2xl p-5 space-y-1">
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Max Drawdown</p>
              <h3 className="text-2xl font-bold text-red-400">-{result.summary.maxDrawdown.toFixed(2)}%</h3>
            </div>
            <div className="bg-zinc-900/50 border border-white/10 rounded-2xl p-5 space-y-1">
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Final Balance</p>
              <h3 className="text-2xl font-bold text-white">${result.summary.finalBalance.toFixed(2)}</h3>
              <p className="text-xs text-zinc-500">Initial: $1000</p>
            </div>
          </div>

          {/* AI Optimization */}
          <div className="bg-zinc-900/50 border border-indigo-500/20 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold flex items-center gap-2 text-indigo-400">
                <Brain className="w-5 h-5" />
                AI Strategy Optimization
              </h3>
              <div className="flex items-center gap-3">
                {aiAnalysis && (
                  <button
                    onClick={saveApprovedSettings}
                    disabled={savingSettings}
                    className={`font-bold py-2 px-4 rounded-xl transition-all flex items-center gap-2 text-sm ${
                      saveSuccess 
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50' 
                        : 'bg-zinc-800 hover:bg-zinc-700 text-white border border-white/10'
                    }`}
                  >
                    {savingSettings ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : saveSuccess ? (
                      <span className="flex items-center gap-2">✓ Tersimpan</span>
                    ) : (
                      'Simpan sebagai Pengaturan Aktif'
                    )}
                  </button>
                )}
                <button
                  onClick={optimizeWithAI}
                  disabled={analyzing}
                  className="bg-indigo-500 hover:bg-indigo-400 disabled:bg-zinc-800 disabled:text-zinc-500 text-white font-bold py-2 px-4 rounded-xl transition-all flex items-center gap-2 shadow-lg shadow-indigo-500/20 text-sm"
                >
                  {analyzing ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Brain className="w-4 h-4" />
                  )}
                  {analyzing ? 'Analyzing...' : 'Optimize with AI'}
                </button>
              </div>
            </div>
            
            {aiAnalysis && (
              <div className="bg-black/50 border border-indigo-500/10 rounded-xl p-6 prose prose-invert prose-indigo max-w-none prose-sm">
                <Markdown>{aiAnalysis}</Markdown>
              </div>
            )}
            {!aiAnalysis && !analyzing && (
              <div className="text-center py-8 text-zinc-500 text-sm">
                Click "Optimize with AI" to get actionable recommendations based on these backtest results.
              </div>
            )}
          </div>

          {/* Equity Chart */}
          <div className="bg-zinc-900/50 border border-white/10 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold flex items-center gap-2">
                <BarChart2 className="w-5 h-5 text-emerald-400" />
                Equity Curve
              </h3>
            </div>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={result.equityCurve}>
                  <defs>
                    <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis 
                    dataKey="time" 
                    hide 
                  />
                  <YAxis 
                    domain={['auto', 'auto']} 
                    stroke="#71717a" 
                    fontSize={12}
                    tickFormatter={(val) => `$${val}`}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#09090b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                    labelFormatter={(label) => formatTime(label)}
                    formatter={(val: number) => [`$${val.toFixed(2)}`, 'Balance']}
                  />
                  <Area 
                    type="monotone" 
                    dataKey="balance" 
                    stroke="#10b981" 
                    fillOpacity={1} 
                    fill="url(#colorBalance)" 
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Trade History */}
          <div className="bg-zinc-900/50 border border-white/10 rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-bottom border-white/10 flex items-center justify-between bg-white/5">
              <h3 className="text-lg font-bold flex items-center gap-2">
                <History className="w-5 h-5 text-emerald-400" />
                Trade History
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-black/50 text-zinc-400 uppercase text-[10px] tracking-widest">
                  <tr>
                    <th className="px-6 py-3 font-medium">Time</th>
                    <th className="px-6 py-3 font-medium">Type</th>
                    <th className="px-6 py-3 font-medium">Entry</th>
                    <th className="px-6 py-3 font-medium">Exit</th>
                    <th className="px-6 py-3 font-medium">Reason</th>
                    <th className="px-6 py-3 font-medium">Profit</th>
                    <th className="px-6 py-3 font-medium text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {result.trades.map((trade, i) => (
                    <tr key={i} className="hover:bg-white/5 transition-colors">
                      <td className="px-6 py-4">
                        <div className="text-white font-medium">{formatTime(trade.exitTime)}</div>
                        <div className="text-[10px] text-zinc-500">Duration: {((trade.exitTime - trade.entryTime) / (1000 * 60 * 60)).toFixed(1)}h</div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${trade.type === 'LONG' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                          {trade.type}
                        </span>
                        {trade.isHedged && (
                          <span className="ml-2 px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 text-[8px] font-bold uppercase">
                            Hedged {trade.hedgeCount > 1 ? `x${trade.hedgeCount}` : ''}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-zinc-300">${trade.entryPrice.toLocaleString()}</td>
                      <td className="px-6 py-4 text-zinc-300">${trade.exitPrice.toLocaleString()}</td>
                      <td className="px-6 py-4">
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                          trade.exitReason === 'STOP_LOSS' ? 'bg-red-500/10 text-red-400' :
                          trade.exitReason === 'TAKE_PROFIT' ? 'bg-emerald-500/10 text-emerald-400' :
                          'bg-zinc-800 text-zinc-400'
                        }`}>
                          {trade.exitReason}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className={`font-bold ${trade.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {trade.profit >= 0 ? '+' : ''}{trade.profitPct.toFixed(2)}%
                        </div>
                        <div className="text-[10px] text-zinc-500">${trade.profit.toFixed(2)}</div>
                      </td>
                      <td className="px-6 py-4 text-right font-mono text-zinc-400">
                        ${trade.finalBalance.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default BacktestView;
