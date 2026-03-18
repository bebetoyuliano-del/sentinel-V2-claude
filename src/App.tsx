import { useEffect, useState } from 'react';
import { Activity, Play, Square, TrendingUp, AlertCircle, RefreshCw, MessageSquare, Target, BarChart2, X, Bot, User, Send } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { AdvancedRealTimeChart } from 'react-ts-tradingview-widgets';

interface Status {
  isBotRunning: boolean;
  apiKeysConfigured: {
    binance: boolean;
    telegram: boolean;
  };
}

interface MarketData {
  BTC?: any;
  ETH?: any;
}

interface Signal {
  id: string;
  timestamp: string;
  content: string;
}

interface AccountData {
  marginRatio: number;
  marginAvailable: number;
  walletBalance: number;
  unrealizedPnl: number;
  dailyRealizedPnl: number;
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [market, setMarket] = useState<MarketData>({});
  const [positions, setPositions] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [account, setAccount] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showChart, setShowChart] = useState(false);
  const [chartSymbol, setChartSymbol] = useState('BINANCE:BTCUSDT.P');
  const [activeTab, setActiveTab] = useState<'signals' | 'chat'>('signals');
  const [chatMessages, setChatMessages] = useState<{role: 'user'|'ai', content: string}[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [isForceRunning, setIsForceRunning] = useState(false);

  // Helper to format CCXT symbol to TradingView Futures symbol
  const getTVSymbol = (sym: string) => {
    const baseQuote = sym.split(':')[0]; // Remove CCXT suffix like :USDT
    const clean = baseQuote.replace(/[^A-Z0-9]/g, ''); // Remove slashes
    return `BINANCE:${clean}.P`;
  };

  const fetchData = async () => {
    try {
      setError(null);
      const [statusRes, marketRes, positionsRes, signalsRes, ordersRes, accountRes] = await Promise.all([
        fetch('/api/status'),
        fetch('/api/market'),
        fetch('/api/positions'),
        fetch('/api/signals'),
        fetch('/api/orders'),
        fetch('/api/account')
      ]);

      if (!statusRes.ok) throw new Error('Failed to fetch status');
      
      setStatus(await statusRes.json());
      
      const marketData = await marketRes.json().catch(() => ({}));
      setMarket(marketData.error ? {} : marketData);
      
      const posData = await positionsRes.json().catch(() => []);
      setPositions(Array.isArray(posData) ? posData : []);
      
      const sigData = await signalsRes.json().catch(() => []);
      setSignals(Array.isArray(sigData) ? sigData : []);
      
      const ordData = await ordersRes.json().catch(() => []);
      setOrders(Array.isArray(ordData) ? ordData : []);

      const accData = await accountRes.json().catch(() => null);
      setAccount(accData && !accData.error ? accData : null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const toggleBot = async () => {
    try {
      const res = await fetch('/api/bot/toggle', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to toggle bot');
      setStatus(prev => prev ? { ...prev, isBotRunning: data.isBotRunning } : null);
      setError(null);
    } catch (err: any) {
      console.error('Failed to toggle bot', err);
      setError(err.message);
    }
  };

  const forceRun = async () => {
    if (isForceRunning) return;
    setIsForceRunning(true);
    try {
      const res = await fetch('/api/bot/force-run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to force run');
      await fetchData(); // Refresh data after run
      setError(null);
    } catch (err: any) {
      console.error('Failed to force run', err);
      setError(err.message);
    } finally {
      setIsForceRunning(false);
    }
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || isChatting) return;
    
    const userMsg = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setIsChatting(true);
    
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg })
      });
      const data = await res.json();
      if (data.reply) {
        setChatMessages(prev => [...prev, { role: 'ai', content: data.reply }]);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setIsChatting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-400">
        <RefreshCw className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  const isConfigured = status?.apiKeysConfigured.binance && status?.apiKeysConfigured.telegram;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
              <Activity className="w-5 h-5 text-emerald-400" />
            </div>
            <h1 className="text-lg font-semibold tracking-tight">Crypto Sentinel</h1>
          </div>
          
          <div className="flex items-center gap-4">
            {!isConfigured && (
              <div className="flex items-center gap-2 text-xs font-medium text-amber-400 bg-amber-400/10 px-3 py-1.5 rounded-full border border-amber-400/20">
                <AlertCircle className="w-4 h-4" />
                API Keys Missing
              </div>
            )}
            
            <div className="flex items-center gap-2">
              <span className="text-sm text-zinc-400">Status:</span>
              <span className={`flex items-center gap-1.5 text-sm font-medium px-2.5 py-1 rounded-full ${status?.isBotRunning ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${status?.isBotRunning ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-500'}`} />
                {status?.isBotRunning ? 'Active' : 'Stopped'}
              </span>
            </div>

            <button
              onClick={toggleBot}
              disabled={!isConfigured}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${status?.isBotRunning ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20' : 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed'}`}
            >
              {status?.isBotRunning ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              {status?.isBotRunning ? 'Stop Bot' : 'Start Bot'}
            </button>
            
            <button
              onClick={() => setShowChart(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-all border border-zinc-700"
            >
              <BarChart2 className="w-4 h-4" />
              View Chart
            </button>

            <button
              onClick={forceRun}
              disabled={!isConfigured || isForceRunning}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed border border-zinc-700"
            >
              <RefreshCw className={`w-4 h-4 ${isForceRunning ? 'animate-spin text-emerald-400' : ''}`} />
              {isForceRunning ? 'Running Analysis...' : 'Force Run'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {account && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
              <div className="text-xs text-zinc-500 mb-1">Margin Ratio</div>
              <div className={`text-lg font-mono font-medium ${account.marginRatio > 25 ? 'text-red-400' : 'text-emerald-400'}`}>
                {account.marginRatio.toFixed(2)}%
              </div>
              <div className="text-[10px] text-zinc-600">Max Safe: 25%</div>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
              <div className="text-xs text-zinc-500 mb-1">Margin Available</div>
              <div className="text-lg font-mono font-medium text-zinc-200">
                ${account.marginAvailable.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
              <div className="text-xs text-zinc-500 mb-1">Wallet Balance</div>
              <div className="text-lg font-mono font-medium text-zinc-200">
                ${account.walletBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
              <div className="text-xs text-zinc-500 mb-1">Unrealized PnL</div>
              <div className={`text-lg font-mono font-medium ${account.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                ${account.unrealizedPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
              <div className="text-xs text-zinc-500 mb-1">Daily Realized PnL</div>
              <div className={`text-lg font-mono font-medium ${account.dailyRealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                ${account.dailyRealizedPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3 text-red-400">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column: Market & Positions */}
          <div className="space-y-8 lg:col-span-1">
            {/* Market Overview */}
            <section>
              <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                <TrendingUp className="w-4 h-4" />
                Market Overview
              </h2>
              <div className="grid grid-cols-2 gap-4">
                {['BTC', 'ETH'].map(coin => {
                  const data = market[coin as keyof MarketData];
                  if (!data) return null;
                  return (
                    <div 
                      key={coin} 
                      onClick={() => {
                        setChartSymbol(`BINANCE:${coin}USDT.P`);
                        setShowChart(true);
                      }}
                      className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 cursor-pointer hover:border-emerald-500/50 transition-colors group"
                    >
                      <div className="flex justify-between items-center mb-1">
                        <div className="text-sm text-zinc-400">{coin}/USDT</div>
                        <BarChart2 className="w-4 h-4 text-zinc-600 group-hover:text-emerald-400 transition-colors" />
                      </div>
                      <div className="text-xl font-mono font-medium">
                        ${parseFloat(data.last).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Active Positions */}
            <section>
              <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Activity className="w-4 h-4" />
                Active Positions
              </h2>
              <div className="space-y-3">
                {positions.length === 0 ? (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 text-center text-sm text-zinc-500">
                    No active positions found
                  </div>
                ) : (
                  positions.map((pos, i) => {
                    const amt = pos.contracts !== undefined ? pos.contracts : Math.abs(parseFloat(pos.positionAmt || '0'));
                    const isLong = pos.side ? pos.side === 'long' : parseFloat(pos.positionAmt || '0') > 0;
                    const entryPrice = pos.entryPrice !== undefined ? pos.entryPrice : parseFloat(pos.avgEntryPrice || pos.entryPrice || '0');
                    const pnl = pos.unrealizedPnl !== undefined ? pos.unrealizedPnl : parseFloat(pos.unrealizedProfit || pos.unRealizedProfit || '0');
                    const leverage = pos.leverage || 1;

                    return (
                      <div 
                        key={i} 
                        onClick={() => {
                          setChartSymbol(getTVSymbol(pos.symbol));
                          setShowChart(true);
                        }}
                        className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 cursor-pointer hover:border-emerald-500/50 transition-colors group"
                      >
                        <div className="flex justify-between items-start mb-2">
                          <div className="flex items-center gap-2">
                            <div className="font-medium">{pos.symbol}</div>
                            <BarChart2 className="w-4 h-4 text-zinc-600 group-hover:text-emerald-400 transition-colors" />
                          </div>
                          <div className={`text-xs font-medium px-2 py-0.5 rounded-full ${isLong ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                            {isLong ? 'LONG' : 'SHORT'} {leverage}x
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          <div>
                            <div className="text-zinc-500 text-xs">Size</div>
                            <div className="font-mono">{amt}</div>
                          </div>
                          <div>
                            <div className="text-zinc-500 text-xs">Entry Price</div>
                            <div className="font-mono">${parseFloat(entryPrice).toFixed(2)}</div>
                          </div>
                          <div className="col-span-2 mt-1">
                            <div className="text-zinc-500 text-xs">Unrealized PnL</div>
                            <div className={`font-mono ${parseFloat(pnl) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              ${parseFloat(pnl).toFixed(2)}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            {/* Open Orders */}
            <section>
              <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Target className="w-4 h-4" />
                Open Orders
              </h2>
              <div className="space-y-3">
                {orders.length === 0 ? (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 text-center text-sm text-zinc-500">
                    No open orders found
                  </div>
                ) : (
                  orders.map((order, i) => {
                    const isBuy = order.side === 'buy';
                    return (
                      <div 
                        key={i} 
                        onClick={() => {
                          setChartSymbol(getTVSymbol(order.symbol));
                          setShowChart(true);
                        }}
                        className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 cursor-pointer hover:border-emerald-500/50 transition-colors group"
                      >
                        <div className="flex justify-between items-start mb-2">
                          <div className="flex items-center gap-2">
                            <div className="font-medium">{order.symbol}</div>
                            <BarChart2 className="w-4 h-4 text-zinc-600 group-hover:text-emerald-400 transition-colors" />
                          </div>
                          <div className={`text-xs font-medium px-2 py-0.5 rounded-full ${isBuy ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                            {order.type.toUpperCase()} {order.side.toUpperCase()}
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          <div>
                            <div className="text-zinc-500 text-xs">Amount</div>
                            <div className="font-mono">{order.amount}</div>
                          </div>
                          <div>
                            <div className="text-zinc-500 text-xs">Price</div>
                            <div className="font-mono">${parseFloat(order.price).toFixed(2)}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>

          {/* Right Column: Signals & Chat */}
          <div className="lg:col-span-2 flex flex-col h-[calc(100vh-8rem)]">
            <div className="flex items-center gap-4 mb-4 border-b border-zinc-800 pb-2">
              <button 
                onClick={() => setActiveTab('signals')}
                className={`text-sm font-medium flex items-center gap-2 px-2 py-1 border-b-2 transition-colors ${activeTab === 'signals' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-zinc-400 hover:text-zinc-300'}`}
              >
                <MessageSquare className="w-4 h-4" />
                Recent Signals
              </button>
              <button 
                onClick={() => setActiveTab('chat')}
                className={`text-sm font-medium flex items-center gap-2 px-2 py-1 border-b-2 transition-colors ${activeTab === 'chat' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-zinc-400 hover:text-zinc-300'}`}
              >
                <Bot className="w-4 h-4" />
                Chat with AI
              </button>
            </div>

            <div className="flex-1 overflow-y-auto min-h-0">
              {activeTab === 'signals' ? (
                <div className="space-y-4">
                  {signals.length === 0 ? (
                    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center text-zinc-500">
                      <MessageSquare className="w-8 h-8 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">No signals generated yet.</p>
                      <p className="text-xs mt-1">Start the bot or force a run to generate analysis.</p>
                    </div>
                  ) : (
                    signals.map(signal => (
                      <div key={signal.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                        <div className="text-xs text-zinc-500 mb-4 font-mono">
                          {new Date(signal.timestamp).toLocaleString()}
                        </div>
                        <div className="prose prose-invert prose-sm max-w-none prose-p:leading-relaxed prose-pre:bg-zinc-950 prose-pre:border prose-pre:border-zinc-800">
                          <ReactMarkdown>{signal.content}</ReactMarkdown>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="flex flex-col h-full bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                  <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {chatMessages.length === 0 && (
                      <div className="text-center text-zinc-500 mt-10">
                        <Bot className="w-8 h-8 mx-auto mb-3 opacity-20" />
                        <p className="text-sm">Tanyakan sesuatu tentang pasar atau posisi Anda.</p>
                        <p className="text-xs mt-1">AI memiliki konteks penuh tentang portofolio Anda.</p>
                      </div>
                    )}
                    {chatMessages.map((msg, i) => (
                      <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${msg.role === 'user' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-800 text-zinc-400'}`}>
                          {msg.role === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                        </div>
                        <div className={`max-w-[80%] rounded-2xl p-3 text-sm ${msg.role === 'user' ? 'bg-emerald-500/10 text-emerald-100 border border-emerald-500/20' : 'bg-zinc-800 text-zinc-300 border border-zinc-700 whitespace-pre-wrap'}`}>
                          {msg.content}
                        </div>
                      </div>
                    ))}
                    {isChatting && (
                      <div className="flex gap-3">
                        <div className="w-8 h-8 rounded-full bg-zinc-800 text-zinc-400 flex items-center justify-center shrink-0">
                          <Bot className="w-4 h-4" />
                        </div>
                        <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-3 text-sm text-zinc-400 flex items-center gap-2">
                          <div className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-pulse" />
                          <div className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }} />
                          <div className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-pulse" style={{ animationDelay: '0.4s' }} />
                        </div>
                      </div>
                    )}
                  </div>
                  <form onSubmit={sendMessage} className="p-3 border-t border-zinc-800 bg-zinc-950 flex gap-2">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                      placeholder="Tanya AI tentang market..."
                      className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-emerald-500/50 transition-colors"
                    />
                    <button 
                      type="submit"
                      disabled={!chatInput.trim() || isChatting}
                      className="bg-emerald-500 text-zinc-950 p-2 rounded-lg hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </form>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* TradingView Chart Modal */}
      {showChart && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 sm:p-6 backdrop-blur-sm">
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-7xl h-[85vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="flex justify-between items-center p-4 border-b border-zinc-800 bg-zinc-900/50">
              <div className="flex items-center gap-4">
                <h2 className="font-semibold flex items-center gap-2 text-zinc-100">
                  <BarChart2 className="w-5 h-5 text-emerald-400"/> 
                  Technical Analysis
                </h2>
                <div className="flex gap-2">
                  {Array.from(new Set(['BINANCE:BTCUSDT.P', 'BINANCE:ETHUSDT.P', chartSymbol])).map(sym => (
                    <button
                      key={sym}
                      onClick={() => setChartSymbol(sym)}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                        chartSymbol === sym 
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                          : 'bg-zinc-800 text-zinc-400 border border-zinc-700 hover:bg-zinc-700'
                      }`}
                    >
                      {sym.replace('BINANCE:', '').replace('.P', '')}
                    </button>
                  ))}
                </div>
              </div>
              <button 
                onClick={() => setShowChart(false)} 
                className="text-zinc-400 hover:text-white p-2 hover:bg-zinc-800 rounded-lg transition-colors"
              >
                <X className="w-5 h-5"/>
              </button>
            </div>
            <div className="flex-1 w-full h-full bg-zinc-950 p-1">
              <AdvancedRealTimeChart 
                theme="dark" 
                symbol={chartSymbol} 
                width="100%" 
                height="100%" 
                allow_symbol_change={true}
                toolbar_bg="#09090b"
                hide_side_toolbar={false}
                show_popup_button={true}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
