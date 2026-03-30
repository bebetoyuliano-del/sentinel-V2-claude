export interface PolicyContextData {
  symbol: string;
  action: string;
  accountMrDecimal: number | null;
  mrProjected: number | null;
  trendStatus: string;
  contextMode: string;
  longPos: any;
  shortPos: any;
  netDirection: string;
  netBEP: number | null;
  atr4h: number | null;
  volatilityRegime: string;
  currentPrice?: number;
}

export class PolicyContext {
  private data: PolicyContextData;

  constructor(data: PolicyContextData) {
    this.data = data;
  }

  get symbol() { return this.data.symbol; }
  get action() { return this.data.action; }
  get accountMrDecimal() { return this.data.accountMrDecimal; }
  get mrProjected() { return this.data.mrProjected; }
  get trendStatus() { return this.data.trendStatus; }
  get contextMode() { return this.data.contextMode; }
  get longPos() { return this.data.longPos; }
  get shortPos() { return this.data.shortPos; }
  get netDirection() { return this.data.netDirection; }
  get netBEP() { return this.data.netBEP; }
  get atr4h() { return this.data.atr4h; }
  get volatilityRegime() { return this.data.volatilityRegime; }
  get currentPrice() { return this.data.currentPrice; }

  isLocked11(): boolean {
    const longQty = parseFloat(this.data.longPos?.positionAmt || '0');
    const shortQty = Math.abs(parseFloat(this.data.shortPos?.positionAmt || '0'));
    return longQty > 0 && longQty === shortQty;
  }

  isNetLong(): boolean {
    const longQty = parseFloat(this.data.longPos?.positionAmt || '0');
    const shortQty = Math.abs(parseFloat(this.data.shortPos?.positionAmt || '0'));
    return longQty > shortQty;
  }

  isNetShort(): boolean {
    const longQty = parseFloat(this.data.longPos?.positionAmt || '0');
    const shortQty = Math.abs(parseFloat(this.data.shortPos?.positionAmt || '0'));
    return shortQty > longQty;
  }

  hasLong(): boolean {
    return parseFloat(this.data.longPos?.positionAmt || '0') > 0;
  }

  hasShort(): boolean {
    return Math.abs(parseFloat(this.data.shortPos?.positionAmt || '0')) > 0;
  }

  isLongGreen(): boolean {
    if (!this.hasLong()) return false;
    const entryPrice = parseFloat(this.data.longPos?.entryPrice || '0');
    const markPrice = this.data.currentPrice || parseFloat(this.data.longPos?.markPrice || '0');
    if (entryPrice === 0 || markPrice === 0) return false;
    return markPrice > entryPrice;
  }

  isShortGreen(): boolean {
    if (!this.hasShort()) return false;
    const entryPrice = parseFloat(this.data.shortPos?.entryPrice || '0');
    const markPrice = this.data.currentPrice || parseFloat(this.data.shortPos?.markPrice || '0');
    if (entryPrice === 0 || markPrice === 0) return false;
    return markPrice < entryPrice;
  }
}
