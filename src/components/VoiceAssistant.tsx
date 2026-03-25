import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Loader2, Volume2 } from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
import { db } from '../firebase';

// Utility functions for PCM16 conversion
function floatTo16BitPCM(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return output;
}

function base64EncodeAudio(int16Array: Int16Array) {
  let binary = '';
  const bytes = new Uint8Array(int16Array.buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64DecodeAudio(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export default function VoiceAssistant() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const connect = async () => {
    setIsConnecting(true);
    setError(null);
    try {
      // Fetch context data from Firestore
      let contextString = "";
      try {
        if (db) {
          // Add a timeout to prevent hanging
          const fetchWithTimeout = async (promise: Promise<any>, timeoutMs: number) => {
            let timeoutHandle: any;
            const timeoutPromise = new Promise((_, reject) => {
              timeoutHandle = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
            });
            return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutHandle));
          };

          const truncate = (str: string, maxLen: number) => str.length > maxLen ? str.substring(0, maxLen) + '...' : str;

          // Fetch last 3 signals/decision cards
          const qSignals = query(collection(db, 'signals'), orderBy('timestamp', 'desc'), limit(3));
          const signalsSnap = await fetchWithTimeout(getDocs(qSignals), 3000);
          const recentSignals = signalsSnap.docs.map((d: any) => truncate(d.data().content || '', 300)).join('\n---\n');
          
          // Fetch last 3 chats
          const qChats = query(collection(db, 'chats'), orderBy('timestamp', 'desc'), limit(3));
          const chatsSnap = await fetchWithTimeout(getDocs(qChats), 3000);
          const recentChats = chatsSnap.docs.map((d: any) => `${d.data().role}: ${truncate(d.data().content || '', 300)}`).reverse().join('\n');
          
          // Fetch open positions
          const posSnap = await fetchWithTimeout(getDocs(collection(db, 'paper_positions')), 3000);
          const openPositions = posSnap.docs.map((d: any) => {
            const data = d.data();
            return `${data.side} ${data.symbol} | Size: ${data.size} | PnL: $${data.unrealizedPnl?.toFixed(2) || 0}`;
          }).join('\n');

          contextString = `\n\n=== KONTEKS SAAT INI ===\n[Posisi Terbuka]:\n${openPositions || 'Tidak ada posisi terbuka.'}\n\n[3 Sinyal/Decision Card Terakhir]:\n${recentSignals || 'Belum ada sinyal.'}\n\n[3 Chat Terakhir dengan High Level AI]:\n${recentChats || 'Belum ada chat.'}\n========================\n\nGunakan konteks di atas untuk menjawab pertanyaan pengguna agar lebih relevan dengan kondisi trading mereka saat ini.`;
        }
      } catch (e) {
        console.error("Failed to fetch context for Voice AI from Firestore, falling back to API", e);
        try {
          const res = await fetch('/api/signals');
          if (res.ok) {
            const data = await res.json();
            const truncate = (str: string, maxLen: number) => str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
            const recentSignals = data.slice(0, 3).map((d: any) => truncate(d.content || '', 300)).join('\n---\n');
            contextString = `\n\n=== KONTEKS SAAT INI (OFFLINE MODE) ===\n[3 Sinyal/Decision Card Terakhir]:\n${recentSignals || 'Belum ada sinyal.'}\n========================\n\nGunakan konteks di atas untuk menjawab pertanyaan pengguna agar lebih relevan dengan kondisi trading mereka saat ini.`;
          }
        } catch (apiErr) {
          console.error("Failed to fetch context from API", apiErr);
        }
      }

      // API Key is injected by the platform
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioContextClass({ sampleRate: 16000 });
      
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1,
        sampleRate: 16000,
      } });
      
      const source = audioContextRef.current.createMediaStreamSource(streamRef.current);
      processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      
      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: `Anda adalah AI Voice Assistant untuk aplikasi "Crypto Sentinel V2". Anda harus berbicara dalam bahasa Indonesia yang santai, profesional, dan ringkas.

TUGAS UTAMA:
Membantu pengguna memahami dashboard trading, sinyal, dan SOP (Standard Operating Procedure) dari Crypto Sentinel V2.

SOP & KONSEP UTAMA CRYPTO SENTINEL V2:
1. Sinyal Trading (Scanner): Bot mencari sinyal berdasarkan Momentum Reversal (MR), Risk/Reward (RR) minimal 1:1.5, dan konfirmasi indikator (WAE, RQK, SMC Zones).
2. Mode Validasi:
   - STRICT: Syarat sangat ketat, sinyal jarang tapi akurat.
   - MODERATE: Seimbang antara jumlah sinyal dan akurasi.
   - RELAXED: Sinyal banyak, risiko lebih tinggi.
3. Paper Trading: Bot bisa melakukan trading simulasi otomatis jika mode "ALLOW_SIGNALS" aktif.
4. Decision Cards: Kartu keputusan untuk posisi yang sedang berjalan. Tombol aksi (seperti REDUCE, ADD, LOCK, UNLOCK, TAKE_PROFIT) HANYA muncul jika AI memberikan Harga Target (Target Price) atau Stop Price yang jelas. Jika hanya menyarankan "HOLD", tombol tidak akan muncul untuk mencegah eksekusi tanpa rencana.
5. Risk Management (Guardrail): Bot memantau batas MR (misal Limit 25%). Jika MR sudah 18%, bot akan menyarankan lot kecil (misal 0.5 lot) untuk menjaga guardrail.

ATURAN MENJAWAB:
- Jawab dengan singkat, padat, dan jelas (maksimal 2-3 kalimat per respons agar tidak terlalu panjang saat diucapkan).
- Jika pengguna bertanya tentang strategi, ingatkan mereka tentang SOP di atas.
- Selalu gunakan nada suara yang percaya diri layaknya asisten trader profesional.${contextString}`,
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setIsConnecting(false);
            
            processorRef.current!.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcm16 = floatTo16BitPCM(inputData);
              const base64Data = base64EncodeAudio(pcm16);
              
              sessionPromise.then((session) => {
                session.sendRealtimeInput({
                  audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                });
              }).catch(console.error);
            };
            
            source.connect(processorRef.current!);
            processorRef.current!.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              setIsSpeaking(true);
              playAudioChunk(base64Audio);
            }
            
            if (message.serverContent?.interrupted) {
              // Stop current playback
              stopAllPlayback();
              setIsSpeaking(false);
            }
            
            if (message.serverContent?.turnComplete) {
               // We don't immediately set isSpeaking to false here because audio might still be playing
               // It will naturally finish when the queue is empty
            }
          },
          onclose: () => {
            disconnect();
          },
          onerror: (err) => {
            console.error("Live API Error:", err);
            setError("Connection error. Please try again.");
            disconnect();
          }
        }
      });
      
      sessionRef.current = sessionPromise;
      
    } catch (err: any) {
      console.error("Failed to connect:", err);
      setError(err.message || "Failed to access microphone.");
      disconnect();
    }
  };

  const playAudioChunk = (base64Audio: string) => {
    if (!audioContextRef.current) return;
    
    const pcm16 = base64DecodeAudio(base64Audio);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768.0;
    }
    
    // Gemini Live API returns 24kHz audio
    const buffer = audioContextRef.current.createBuffer(1, float32.length, 24000); 
    buffer.getChannelData(0).set(float32);
    
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    
    const currentTime = audioContextRef.current.currentTime;
    if (playbackTimeRef.current < currentTime) {
      playbackTimeRef.current = currentTime;
    }
    
    source.start(playbackTimeRef.current);
    playbackTimeRef.current += buffer.duration;
    
    activeSourcesRef.current.push(source);
    
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
      if (activeSourcesRef.current.length === 0) {
        setIsSpeaking(false);
      }
    };
  };

  const stopAllPlayback = () => {
    activeSourcesRef.current.forEach(source => {
      try {
        source.stop();
      } catch (e) {
        // Ignore errors if already stopped
      }
    });
    activeSourcesRef.current = [];
    if (audioContextRef.current) {
      playbackTimeRef.current = audioContextRef.current.currentTime;
    }
  };

  const disconnect = () => {
    setIsConnected(false);
    setIsConnecting(false);
    setIsSpeaking(false);
    stopAllPlayback();
    
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(console.error);
      audioContextRef.current = null;
    }
    if (sessionRef.current) {
      sessionRef.current.then((session: any) => session.close()).catch(console.error);
      sessionRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []);

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
      {error && (
        <div className="bg-red-500/90 text-white text-xs px-3 py-2 rounded-lg shadow-lg max-w-[200px] mb-2 backdrop-blur-sm">
          {error}
        </div>
      )}
      
      {isConnected && (
        <div className="bg-slate-800/90 backdrop-blur-md border border-slate-700 text-slate-200 text-sm px-4 py-2 rounded-full shadow-xl flex items-center gap-3 mb-2 animate-in fade-in slide-in-from-bottom-4">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isSpeaking ? 'bg-blue-500 animate-pulse' : 'bg-emerald-500'}`} />
            <span className="font-medium">{isSpeaking ? 'AI is speaking...' : 'Listening...'}</span>
          </div>
          {isSpeaking && <Volume2 className="w-4 h-4 text-blue-400 animate-pulse" />}
        </div>
      )}

      <button
        onClick={isConnected ? disconnect : connect}
        disabled={isConnecting}
        className={`w-14 h-14 rounded-full flex items-center justify-center shadow-2xl transition-all duration-300 hover:scale-105 active:scale-95 ${
          isConnecting 
            ? 'bg-slate-700 text-slate-400 cursor-not-allowed' 
            : isConnected 
              ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-500/20' 
              : 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/20'
        }`}
        title={isConnected ? "End Voice Conversation" : "Start Voice Conversation"}
      >
        {isConnecting ? (
          <Loader2 className="w-6 h-6 animate-spin" />
        ) : isConnected ? (
          <MicOff className="w-6 h-6" />
        ) : (
          <Mic className="w-6 h-6" />
        )}
      </button>
    </div>
  );
}
