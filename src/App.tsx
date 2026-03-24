import { useEffect, useState } from 'react';
import { Activity, Play, Square, TrendingUp, AlertCircle, RefreshCw, MessageSquare, Target, BarChart2, X, Bot, User, Send, LogOut, CheckCircle2, BookOpen, FlaskConical } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { AdvancedRealTimeChart } from 'react-ts-tradingview-widgets';
import { auth, db, loginWithGoogle, logout } from './firebase';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { collection, query, orderBy, limit, onSnapshot, addDoc, serverTimestamp, getDocFromServer, doc } from 'firebase/firestore';
import BacktestView from './components/BacktestView';
import PaperTradingView from './components/PaperTradingView';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface Status {
  isBotRunning: boolean;
  apiKeysConfigured: {
    binance: boolean;
    telegram: boolean;
    email?: boolean;
    webhook?: boolean;
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
  type?: string;
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
  const [activeTab, setActiveTab] = useState<'signals' | 'chat' | 'journal' | 'backtest' | 'paper'>('signals');
  const [chatMessages, setChatMessages] = useState<{role: 'user'|'ai', content: string}[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [isForceRunning, setIsForceRunning] = useState(false);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [journal, setJournal] = useState<any[]>([]);
  const [journalFilter, setJournalFilter] = useState<'ALL' | 'AI' | 'PAPER_BOT' | 'USER'>('ALL');
  const [isSyncing, setIsSyncing] = useState(false);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const res = await fetch('/api/journal/sync', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert(`Successfully synced ${data.syncedCount} trades from Binance.`);
      } else {
        alert(`Failed to sync: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Error syncing: ${err.message}`);
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. ");
        }
      }
    }
    testConnection();

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Ensure user document exists in Firestore
        const { doc, setDoc, getDoc } = await import('firebase/firestore');
        const userDocRef = doc(db, 'users', currentUser.uid);
        const userDoc = await getDoc(userDocRef);
        if (!userDoc.exists()) {
          await setDoc(userDocRef, {
            name: currentUser.displayName || '',
            email: currentUser.email || '',
            role: currentUser.email === 'bebetoyuliano@gmail.com' ? 'admin' : 'user',
            createdAt: new Date().toISOString()
          });
        }
      }
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;
    
    // Listen to signals from Firestore
    const qSignals = query(collection(db, 'signals'), orderBy('timestamp', 'desc'), limit(50));
    const unsubSignals = onSnapshot(qSignals, (snapshot) => {
      const fetchedSignals = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Signal[];
      setSignals(fetchedSignals);
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'signals');
    });

    // Listen to chat messages
    const qChats = query(collection(db, 'chats'), orderBy('timestamp', 'asc'), limit(100));
    const unsubChats = onSnapshot(qChats, (snapshot) => {
      const fetchedChats = snapshot.docs.map(doc => ({
        role: doc.data().role,
        content: doc.data().content
      }));
      setChatMessages(fetchedChats as any);
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'chats');
    });

    // Listen to journal
    const qJournal = query(collection(db, 'trading_journal'), orderBy('timestamp', 'desc'), limit(100));
    const unsubJournal = onSnapshot(qJournal, (snapshot) => {
      const fetchedJournal = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setJournal(fetchedJournal);
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'trading_journal');
    });

    return () => {
      unsubSignals();
      unsubChats();
      unsubJournal();
    };
  }, [user]);

  // Helper to format CCXT symbol to TradingView Futures symbol
  const getTVSymbol = (sym: string) => {
    const baseQuote = sym.split(':')[0]; // Remove CCXT suffix like :USDT
    const clean = baseQuote.replace(/[^A-Z0-9]/g, ''); // Remove slashes
    return `BINANCE:${clean}.P`;
  };

  const fetchData = async () => {
    try {
      // Don't clear error immediately to avoid flickering, only clear on success
      const fetchWithTimeout = (url: string, ms = 10000) => {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), ms);
        return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(id));
      };

      const [statusRes, marketRes, positionsRes, ordersRes, accountRes] = await Promise.all([
        fetchWithTimeout('/api/status').catch(() => ({ ok: false, json: async () => ({}) })),
        fetchWithTimeout('/api/market').catch(() => ({ ok: false, json: async () => ({}) })),
        fetchWithTimeout('/api/positions').catch(() => ({ ok: false, json: async () => ([]) })),
        fetchWithTimeout('/api/orders').catch(() => ({ ok: false, json: async () => ([]) })),
        fetchWithTimeout('/api/account').catch(() => ({ ok: false, json: async () => null }))
      ]);

      if (statusRes.ok) {
        const data = await statusRes.json().catch(() => null);
        if (data) {
          setStatus(data);
          setError(null); // Clear error on successful status fetch
        }
      }
      
      if (marketRes.ok) {
        const marketData = await marketRes.json().catch(() => ({}));
        setMarket(marketData.error ? {} : marketData);
      }
      
      if (positionsRes.ok) {
        const posData = await positionsRes.json().catch(() => []);
        setPositions(Array.isArray(posData) ? posData : []);
      }
      
      if (ordersRes.ok) {
        const ordData = await ordersRes.json().catch(() => []);
        setOrders(Array.isArray(ordData) ? ordData : []);
      }

      if (accountRes.ok) {
        const accData = await accountRes.json().catch(() => null);
        setAccount(accData && !accData.error ? accData : null);
      }
    } catch (err: any) {
      console.error('Fetch data error:', err);
      // Only set error if it's not an abort/timeout to avoid spamming the user
      if (err.name !== 'AbortError') {
        setError('Failed to fetch data from server. Retrying...');
      }
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

  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const forceRun = async () => {
    if (isForceRunning) return;
    setIsForceRunning(true);
    try {
      const res = await fetch('/api/bot/force-run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to force run');
      setSuccessMsg('Bot run started in background. Check Telegram for updates.');
      setTimeout(() => setSuccessMsg(null), 5000);
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
    setIsChatting(true);
    
    try {
      // Save user message to Firestore
      try {
        await addDoc(collection(db, 'chats'), {
          role: 'user',
          content: userMsg,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, 'chats');
      }

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg })
      });
      const data = await res.json();
      if (data.reply) {
        // Save AI reply to Firestore
        try {
          await addDoc(collection(db, 'chats'), {
            role: 'ai',
            content: data.reply,
            timestamp: new Date().toISOString()
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, 'chats');
        }
      }
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setIsChatting(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-400">
        <RefreshCw className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-100 p-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 mx-auto mb-6">
            <Activity className="w-8 h-8 text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold mb-2">Crypto Sentinel</h1>
          <p className="text-zinc-400 mb-8">Login to access your trading dashboard and AI assistant.</p>
          <button 
            onClick={loginWithGoogle}
            className="w-full flex items-center justify-center gap-3 bg-white text-zinc-900 hover:bg-zinc-100 font-medium py-3 px-4 rounded-xl transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  const isConfigured = status?.apiKeysConfigured.binance;

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

            <button
              onClick={logout}
              className="flex items-center justify-center w-10 h-10 rounded-lg bg-zinc-800 text-zinc-400 hover:bg-red-500/10 hover:text-red-400 transition-all border border-zinc-700 hover:border-red-500/20"
              title="Logout"
            >
              <LogOut className="w-4 h-4" />
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

        {successMsg && (
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 flex items-start gap-3 text-emerald-400">
            <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-sm">{successMsg}</p>
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
              <button 
                onClick={() => setActiveTab('journal')}
                className={`text-sm font-medium flex items-center gap-2 px-2 py-1 border-b-2 transition-colors ${activeTab === 'journal' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-zinc-400 hover:text-zinc-300'}`}
              >
                <BookOpen className="w-4 h-4" />
                Trading Journal
              </button>
              <button 
                onClick={() => setActiveTab('backtest')}
                className={`text-sm font-medium flex items-center gap-2 px-2 py-1 border-b-2 transition-colors ${activeTab === 'backtest' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-zinc-400 hover:text-zinc-300'}`}
              >
                <FlaskConical className="w-4 h-4" />
                Backtest
              </button>
              <button 
                onClick={() => setActiveTab('paper')}
                className={`text-sm font-medium flex items-center gap-2 px-2 py-1 border-b-2 transition-colors ${activeTab === 'paper' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-zinc-400 hover:text-zinc-300'}`}
              >
                <Activity className="w-4 h-4" />
                Paper Trading
              </button>
            </div>

            <div className="flex-1 overflow-y-auto min-h-0">
              {activeTab === 'signals' ? (
                <div className="space-y-4">
                  {signals.filter(s => s.type !== 'scanner_signal').length === 0 ? (
                    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center text-zinc-500">
                      <MessageSquare className="w-8 h-8 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">No signals generated yet.</p>
                      <p className="text-xs mt-1">Start the bot or force a run to generate analysis.</p>
                    </div>
                  ) : (
                    signals.filter(s => s.type !== 'scanner_signal').map(signal => (
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
              ) : activeTab === 'journal' ? (
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
                    <h3 className="text-lg font-bold">Trading Journal</h3>
                    <div className="flex items-center gap-2">
                      <select
                        value={journalFilter}
                        onChange={(e) => setJournalFilter(e.target.value as any)}
                        className="bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      >
                        <option value="ALL">All Sources</option>
                        <option value="PAPER_BOT">Paper Trades</option>
                        <option value="AI">AI Signals</option>
                        <option value="USER">Synced Trades</option>
                      </select>
                      <button
                        onClick={handleSync}
                        disabled={isSyncing}
                        className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50"
                      >
                        <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                        {isSyncing ? 'Syncing...' : 'Sync History'}
                      </button>
                    </div>
                  </div>
                  {journal.length > 0 && (
                    <div className="grid grid-cols-3 gap-4 mb-4">
                      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                        <div className="text-xs text-zinc-500 mb-1">Total Trades</div>
                        <div className="text-2xl font-bold">
                          {journal.filter(entry => journalFilter === 'ALL' || entry.source === journalFilter).length}
                        </div>
                      </div>
                      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                        <div className="text-xs text-zinc-500 mb-1">Win Rate</div>
                        <div className="text-2xl font-bold text-emerald-400">
                          {(() => {
                            const filtered = journal.filter(entry => journalFilter === 'ALL' || entry.source === journalFilter);
                            if (filtered.length === 0) return '0.0%';
                            return ((filtered.filter(j => (j.pnl || 0) > 0).length / filtered.length) * 100).toFixed(1) + '%';
                          })()}
                        </div>
                      </div>
                      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                        <div className="text-xs text-zinc-500 mb-1">Avg PnL</div>
                        <div className={`text-2xl font-bold ${(() => {
                          const filtered = journal.filter(entry => journalFilter === 'ALL' || entry.source === journalFilter);
                          const totalPnl = filtered.reduce((acc, j) => acc + (j.pnl || 0), 0);
                          return totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400';
                        })()}`}>
                          {(() => {
                            const filtered = journal.filter(entry => journalFilter === 'ALL' || entry.source === journalFilter);
                            if (filtered.length === 0) return '0.00';
                            return (filtered.reduce((acc, j) => acc + (j.pnl || 0), 0) / filtered.length).toFixed(2);
                          })()} USDT
                        </div>
                      </div>
                    </div>
                  )}
                  {journal.length === 0 ? (
                    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center text-zinc-500">
                      <BookOpen className="w-8 h-8 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">No journal entries yet.</p>
                      <p className="text-xs mt-1">Trades executed by Sentinel will appear here.</p>
                    </div>
                  ) : (
                    journal
                      .filter(entry => journalFilter === 'ALL' || entry.source === journalFilter)
                      .map(entry => (
                      <div key={entry.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                        <div className="flex justify-between items-start mb-4">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className={`px-2 py-0.5 rounded text-xs font-medium ${entry.side === 'BUY' || entry.side === 'LONG' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                                {entry.side}
                              </span>
                              <span className="font-bold text-lg">{entry.symbol}</span>
                              {entry.source && (
                                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                                  entry.source === 'AI' ? 'bg-indigo-500/20 text-indigo-400' : 
                                  entry.source === 'PAPER_BOT' ? 'bg-emerald-500/20 text-emerald-400' :
                                  'bg-zinc-500/20 text-zinc-400'
                                }`}>
                                  {entry.source === 'AI' ? 'AI Signal' : entry.source === 'PAPER_BOT' ? 'Paper Trade' : 'User Trade'}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-zinc-500 mt-1 font-mono">
                              {new Date(entry.timestamp).toLocaleString()}
                            </div>
                          </div>
                          <div className={`text-right ${entry.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            <div className="font-mono font-bold">
                              {entry.pnl >= 0 ? '+' : ''}{entry.pnl?.toFixed(2) || '0.00'} USDT
                            </div>
                            <div className="text-xs opacity-70">Realized PnL</div>
                          </div>
                        </div>
                        
                        <div className="grid grid-cols-3 gap-4 mb-4 bg-zinc-950 rounded-lg p-3 border border-zinc-800/50">
                          <div>
                            <div className="text-xs text-zinc-500">Entry</div>
                            <div className="font-mono text-sm">${entry.entryPrice}</div>
                          </div>
                          <div>
                            <div className="text-xs text-zinc-500">Stop Loss</div>
                            <div className="font-mono text-sm text-rose-400">{entry.stopLoss ? `$${entry.stopLoss}` : '-'}</div>
                          </div>
                          <div>
                            <div className="text-xs text-zinc-500">Targets</div>
                            <div className="font-mono text-sm text-emerald-400">{entry.target1 ? `$${entry.target1}` : '-'}</div>
                          </div>
                        </div>

                        <div className="space-y-3">
                          <div>
                            <div className="text-xs text-zinc-500 mb-1">Reasoning / Strategy</div>
                            <p className="text-sm text-zinc-300 leading-relaxed">{entry.reason}</p>
                          </div>
                          
                          {entry.sentiment && typeof entry.sentiment === 'object' && (
                            <div className="bg-zinc-950/50 rounded-lg p-3 border border-zinc-800/50">
                              <div className="flex items-center gap-2 mb-1">
                                <div className="text-xs text-zinc-500">Sentiment Analysis</div>
                                <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                                  entry.sentiment.status === 'BULLISH' ? 'bg-emerald-500/20 text-emerald-400' :
                                  entry.sentiment.status === 'BEARISH' ? 'bg-rose-500/20 text-rose-400' :
                                  'bg-zinc-500/20 text-zinc-400'
                                }`}>
                                  {entry.sentiment.status} ({entry.sentiment.score}/100)
                                </span>
                              </div>
                              <p className="text-sm text-zinc-400 italic">"{entry.sentiment.reason}"</p>
                            </div>
                          )}

                          {entry.closeReason && (
                            <div className="text-xs text-zinc-500 italic mt-2">
                              Closed due to: <span className="text-zinc-400">{entry.closeReason}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : activeTab === 'backtest' ? (
                <BacktestView />
              ) : activeTab === 'paper' ? (
                <PaperTradingView />
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
