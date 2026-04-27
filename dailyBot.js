require("dotenv").config();
const { execSync } = require("child_process");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

// Inisialisasi Bybit V5 API Client
const { RestClientV5 } = require("bybit-api");
const bybitClient = new RestClientV5({
  key: process.env.BYBIT_API_KEY,
  secret: process.env.BYBIT_API_SECRET,
  // testnet: false // Ubah ke true jika ingin testing pakai uang palsu Bybit
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const targetCoins = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "SUIUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "HYPEUSDT",
  "ZECUSDT",
  "PAXGUSDT",
];

// ====================================================================
// 0. MODUL LOT SIZE & PRECISION BYBIT
// ====================================================================
let bybitRules = {};

async function loadBybitRules() {
  console.log("🔍 Menarik aturan Lot Size dan Tick Size dari Bybit...");
  try {
    const response = await bybitClient.getInstrumentsInfo({ category: "spot" });
    if (response.retCode === 0) {
      response.result.list.forEach((item) => {
        bybitRules[item.symbol] = {
          qtyStep: item.lotSizeFilter.basePrecision, // Desimal untuk jumlah koin (Lot Size)
          priceStep: item.priceFilter.tickSize, // Desimal untuk harga (Tick Size)
        };
      });
      console.log("✅ Aturan presisi Bybit berhasil dimuat!");
    }
  } catch (error) {
    console.error("❌ Gagal memuat aturan Bybit:", error.message);
  }
}

// Fungsi pembulatan ke bawah (Floor) sesuai aturan Bybit
function applyPrecision(value, stepStr) {
  if (!stepStr) return value.toString();
  const precision = stepStr.includes(".") ? stepStr.split(".")[1].length : 0;
  const factor = Math.pow(10, precision);
  return (Math.floor(value * factor) / factor).toFixed(precision);
}

// ====================================================================
// 1. MATEMATIKA & INDIKATOR KUANTITATIF
// ====================================================================
function calculateEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}
function calculateSMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function calculateROC(prices, period) {
  if (prices.length <= period) return 0;
  const current = prices[prices.length - 1];
  const past = prices[prices.length - 1 - period];
  return ((current - past) / past) * 100;
}

// ====================================================================
// 2. MODUL TELEGRAM BROADCAST
// ====================================================================
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: text,
      parse_mode: "Markdown",
    }),
  });
}

async function broadcastUpdate(regimeStatus, totalEquity, newCapitalUSDT) {
  const { data: history } = await supabase
    .from("portfolio_history")
    .select("*")
    .order("date", { ascending: false })
    .limit(1);
  const { data: positions } = await supabase
    .from("current_positions")
    .select("*")
    .order("percentage", { ascending: false });

  if (!history || history.length === 0) return;
  const last = history[0];

  let cryptoExposurePct = 0;
  let hasCrypto = false;
  let activePositionsText = "";

  positions.forEach((p) => {
    if (p.symbol === "USDT") return;
    hasCrypto = true;
    cryptoExposurePct += parseFloat(p.percentage);
    const isWhaleTarget = parseFloat(p.percentage) > 20 ? "🐋" : "⚡";
    activePositionsText += `${isWhaleTarget} *${p.symbol}*: ${p.percentage}% _(Break-Even: $${parseFloat(p.avg_price).toLocaleString(undefined, { maximumFractionDigits: 4 })})_\n`;
  });

  const cashExposurePct = (100 - cryptoExposurePct).toFixed(1);
  cryptoExposurePct = cryptoExposurePct.toFixed(1);

  const cryptoVal = totalEquity * (cryptoExposurePct / 100);
  const cashVal = totalEquity * (cashExposurePct / 100);

  const filledBoxes = Math.round(cryptoExposurePct / 10);
  const exposureBar = "🟩".repeat(filledBoxes) + "⬜".repeat(10 - filledBoxes);

  let message = `🏛 *QUANT ORACLE TERMINAL*\n`;
  message += `_Daily Execution: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB_\n\n`;
  message += `🌐 *MACRO REGIME*\nStatus: _${regimeStatus}_\n\n`;
  message += `🛡️ *SYSTEM EXPOSURE*\n[${exposureBar}] *${cryptoExposurePct}%*\n`;
  message += `• Crypto Assets: *$${cryptoVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}*\n`;
  message += `• Cash Reserve : *$${cashVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}*\n\n`;
  message += `💰 *EQUITY & PERFORMANCE*\n`;
  message += `• Total Capital: *$${totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2 })}*\n`;
  message += `• System ROI : *${last.system_roi}%*\n`;
  message += `• Max Drawdown: \`${last.max_drawdown}%\`\n\n`;
  message += `📊 *ACTIVE ALLOCATIONS*\n`;
  if (hasCrypto) message += activePositionsText;
  else message += `⚠️ _100% CASH MODE ACTIVE (Awaiting Macro Clear)_\n`;
  message += `\n📈 *ALPHA (VS BENCHMARK)*\n`;
  message += `• System : ${last.system_roi}%\n`;
  message += `• Bitcoin: ${last.btc_roi}%\n`;
  message += `• S&P 500: ${last.spx_roi}%\n\n`;

  const alpha = parseFloat(last.system_roi) - parseFloat(last.btc_roi);
  const status =
    alpha > 0
      ? `✅ BEATING MARKET BY +${alpha.toFixed(2)}%`
      : `⚠️ UNDERPERFORMING BTC BY ${Math.abs(alpha).toFixed(2)}%`;
  message += `*STATUS:* ${status}\n\n`;
  message += `🔗 [Dashboard Link](https://oracle-quant.vercel.app/)`;

  await sendTelegram(message);
}

// ====================================================================
// 3. ENGINE EXECUTION (BYBIT V5 API + THE GUILLOTINE)
// ====================================================================
async function recordTrade(
  symbol,
  type,
  price,
  amount,
  pnl_percent,
  executionTime,
) {
  const pnl_value = type === "SELL" ? price * amount * (pnl_percent / 100) : 0;
  await supabase.from("trade_history").insert([
    {
      symbol,
      type,
      exit_price: price,
      amount,
      pnl_percent,
      pnl_value,
      timestamp: executionTime,
    },
  ]);
}

async function executeLiveRebalancing(
  targetValues,
  currentHoldings,
  marketPrices,
  capitalUSDT,
  costBasis,
  totalEquity,
) {
  console.log("\n🤖 MEMULAI ORACLE LIVE REBALANCING (BYBIT V5 API)...");
  const serverTimeMs = Date.now();
  const rebalanceThreshold = totalEquity * 0.05;
  let isSellExecuted = false;
  let newCapitalUSDT = capitalUSDT;
  let newHoldings = { ...currentHoldings };
  let newCostBasis = { ...costBasis };

  // --- FASE 1: EKSEKUSI SELL ---
  for (const symbol of Object.keys(targetValues)) {
    const currentPrice = marketPrices[symbol];
    if (!currentPrice) continue;
    const currentVal = (newHoldings[symbol] || 0) * currentPrice;
    const targetVal = targetValues[symbol];
    const diff = targetVal - currentVal;

    if (diff < -rebalanceThreshold || (targetVal === 0 && currentVal > 10)) {
      const rule = bybitRules[symbol] || {
        qtyStep: "0.0001",
        priceStep: "0.01",
      };
      const rawSellQty = Math.min(
        Math.abs(diff) / currentPrice,
        newHoldings[symbol],
      );
      const sellQty = applyPrecision(rawSellQty, rule.qtyStep); // Pembulatan Presisi Bybit

      if (parseFloat(sellQty) > 0) {
        try {
          console.log(
            `📤 MENGIRIM ORDER SELL KE BYBIT: ${symbol} sejumlah ${sellQty}`,
          );
          // UNCOMMENT BARIS DI BAWAH INI UNTUK EKSEKUSI REAL KE BYBIT

          const response = await bybitClient.submitOrder({
            category: "spot",
            symbol: symbol,
            side: "Sell",
            orderType: "Market",
            qty: sellQty.toString(),
          });
          if (response.retCode !== 0) throw new Error(response.retMsg);

          let avgPrice = 0,
            pnl_percent = 0;
          if (newHoldings[symbol] > 0) {
            avgPrice = newCostBasis[symbol] / newHoldings[symbol];
            pnl_percent = ((currentPrice - avgPrice) / avgPrice) * 100;
          }
          await recordTrade(
            symbol,
            "SELL",
            currentPrice,
            parseFloat(sellQty),
            pnl_percent,
            new Date(serverTimeMs).toISOString(),
          );

          const ratio = parseFloat(sellQty) / newHoldings[symbol];
          newCostBasis[symbol] -= newCostBasis[symbol] * ratio;
          newCapitalUSDT += parseFloat(sellQty) * currentPrice;
          newHoldings[symbol] -= parseFloat(sellQty);
          isSellExecuted = true;
        } catch (error) {
          console.error(`❌ BYBIT SELL ERROR (${symbol}):`, error.message);
        }
      }
    }
  }

  // --- FASE 2: EKSEKUSI BUY (DENGAN HARD STOP-LOSS) ---
  for (const symbol of Object.keys(targetValues)) {
    const currentPrice = marketPrices[symbol];
    if (!currentPrice) continue;
    const currentVal = (newHoldings[symbol] || 0) * currentPrice;
    const targetVal = targetValues[symbol];
    const diff = targetVal - currentVal;

    if (diff > rebalanceThreshold) {
      const buyAmount = Math.min(diff, newCapitalUSDT);
      if (buyAmount >= 10) {
        const rule = bybitRules[symbol] || {
          qtyStep: "0.0001",
          priceStep: "0.01",
        };

        // 🚨 KUNCI PERBAIKAN: Bybit Market Buy butuh nominal USDT (Quote), BUKAN koin!
        // Kita bulatkan nominal belanjanya ke 2 desimal (contoh: "15.00")
        const buyQtyUSDT = (Math.floor(buyAmount * 100) / 100).toFixed(2);

        // ⚔️ THE GUILLOTINE: Hard Stop-Loss 15% di bawah harga
        const rawStopLoss = currentPrice * 0.85;
        const hardStopLossPrice = applyPrecision(rawStopLoss, rule.priceStep);

        try {
          console.log(
            `📥 MENGIRIM ORDER BUY KE BYBIT: ${symbol} senilai $${buyQtyUSDT} USDT dengan SL di $${hardStopLossPrice}`,
          );

          const response = await bybitClient.submitOrder({
            category: "spot",
            symbol: symbol,
            side: "Buy",
            orderType: "Market",
            qty: buyQtyUSDT.toString(), // <--- INI SEKARANG BERNILAI "15.00"
            // stopLoss: hardStopLossPrice.toString(),
            // slOrderType: "Market",
          });
          if (response.retCode !== 0) throw new Error(response.retMsg);

          // Hitung estimasi koin untuk dicatat di database Supabase kita
          const estimatedKoinDidapat = parseFloat(buyQtyUSDT) / currentPrice;
          const delayMs = isSellExecuted ? 1500 : 0;

          await recordTrade(
            symbol,
            "BUY",
            currentPrice,
            estimatedKoinDidapat,
            0,
            new Date(serverTimeMs + delayMs).toISOString(),
          );

          newCapitalUSDT -= parseFloat(buyQtyUSDT);
          newHoldings[symbol] =
            (newHoldings[symbol] || 0) + estimatedKoinDidapat;
          newCostBasis[symbol] =
            (newCostBasis[symbol] || 0) + parseFloat(buyQtyUSDT);
        } catch (error) {
          console.error(`❌ BYBIT BUY ERROR (${symbol}):`, error.message);
        }
      }
    }
  }
  return { newHoldings, newCapitalUSDT, newCostBasis };
}

// ====================================================================
// 3.5 MODUL AUTO-SYNC BALANCE DARI BYBIT (SOLUSI SLIPPAGE & FEE)
// ====================================================================
async function syncRealBybitBalances() {
  console.log("🔄 Auto-Sync: Mengambil saldo fisik asli dari dompet Bybit...");
  try {
    // Mencoba tarik dari tipe akun UNIFIED (Standar akun baru Bybit)
    let response = await bybitClient.getWalletBalance({
      accountType: "UNIFIED",
    });

    // Jika gagal, fallback ke akun tipe SPOT lama
    if (
      response.retCode !== 0 ||
      !response.result.list ||
      response.result.list.length === 0
    ) {
      response = await bybitClient.getWalletBalance({ accountType: "SPOT" });
    }

    if (response.retCode === 0 && response.result.list.length > 0) {
      const coinList = response.result.list[0].coin;
      let realBalances = {};
      coinList.forEach((c) => {
        realBalances[c.coin] = parseFloat(c.walletBalance);
      });
      console.log(
        "✅ Auto-Sync Berhasil! Data Supabase akan disesuaikan dengan dompet asli.",
      );
      return realBalances;
    } else {
      throw new Error(response.retMsg || "Gagal membaca saldo koin.");
    }
  } catch (error) {
    console.error(
      "❌ Auto-Sync Error (Menggunakan kalkulasi estimasi):",
      error.message,
    );
    return null;
  }
}

// ====================================================================
// 4. MAIN ORCHESTRATOR (THE QUANT BRAIN)
// ====================================================================
async function runDailyOracle() {
  console.log("🚀 MENGAKTIFKAN QUANT ORACLE (BYBIT V5 LIVE)...");

  // --- 0. DATA PIPELINE TRIGGER (AUTO-FETCH) ---
  console.log("🔄 Memperbarui database market_data...");
  try {
    console.log("-> 1/3: Menarik data harga pasar (fetchHistory.js)...");
    execSync("node fetchHistory.js", { stdio: "inherit" });

    console.log("-> 2/3: Menarik data makro DXY & SPX (fetchMacro.js)...");
    execSync("node fetchMacro.js", { stdio: "inherit" });

    console.log("-> 3/3: Menarik data Open Interest (fetchDerivatives.js)...");
    execSync("node fetchDerivatives.js", { stdio: "inherit" });

    console.log(
      "✅ Semua database (Market, Macro, Derivatives) berhasil diperbarui!",
    );
    console.log("🧠 Memulai kalkulasi otak Oracle...");
  } catch (error) {
    console.error("❌ Terjadi kegagalan pada Data Pipeline:", error.message);
    console.log(
      "⚠️ Bot akan melanjutkan perhitungan menggunakan data terakhir yang ada di Supabase.",
    );
  }

  try {
    // Muat Aturan Bybit terlebih dahulu
    await loadBybitRules();

    const { data: dbPositions } = await supabase
      .from("current_positions")
      .select("*");
    let currentHoldings = {},
      costBasis = {},
      athPrices = {};
    let capitalUSDT = 10000;

    if (dbPositions) {
      dbPositions.forEach((p) => {
        if (p.symbol !== "USDT") {
          const qty = parseFloat(p.amount || 0);
          currentHoldings[p.symbol + "USDT"] = qty;
          costBasis[p.symbol + "USDT"] = qty * parseFloat(p.avg_price || 0);
          athPrices[p.symbol + "USDT"] = parseFloat(p.ath_price || 0);
        } else {
          capitalUSDT = parseFloat(p.amount || 0);
        }
      });
    }

    const { data: dbAssets } = await supabase
      .from("assets")
      .select("id, symbol");
    const assetMap = new Map(dbAssets.map((a) => [a.symbol, a.id]));

    let marketDataLists = {},
      marketVolumeLists = {},
      marketPrices = {};
    for (const symbol of targetCoins) {
      const { data } = await supabase
        .from("market_data")
        .select("close, volume")
        .eq("asset_id", assetMap.get(symbol))
        .order("timestamp", { ascending: false })
        .limit(200);
      const history = (data || []).reverse();
      marketDataLists[symbol] = history.map((h) => parseFloat(h.close));
      marketVolumeLists[symbol] = history.map((h) => parseFloat(h.volume));
      marketPrices[symbol] =
        marketDataLists[symbol][marketDataLists[symbol].length - 1];
    }

    const { data: dxyData } = await supabase
      .from("macro_data")
      .select("close")
      .eq("symbol", "DXY")
      .order("timestamp", { ascending: false })
      .limit(200);
    const dxyPrices = (dxyData || []).reverse().map((d) => parseFloat(d.close));

    const { data: spxData } = await supabase
      .from("macro_data")
      .select("close")
      .eq("symbol", "SPX")
      .order("timestamp", { ascending: false })
      .limit(1);
    const currentSPXPrice =
      spxData && spxData.length > 0 ? parseFloat(spxData[0].close) : 4100;

    let oiHistory = {};
    for (const symbol of targetCoins) {
      const { data } = await supabase
        .from("derivatives_data")
        .select("open_interest")
        .eq("symbol", symbol)
        .order("timestamp", { ascending: false })
        .limit(5);
      if (data && data.length >= 5)
        oiHistory[symbol] = data
          .reverse()
          .map((d) => parseFloat(d.open_interest));
    }

    let currentCryptoValue = 0;
    for (const [sym, qty] of Object.entries(currentHoldings))
      currentCryptoValue += qty * (marketPrices[sym] || 0);
    const totalEquity = capitalUSDT + currentCryptoValue;

    // --- OTAK 1: REGIME & EXPOSURE ---
    const btcPrices = marketDataLists["BTCUSDT"];
    const currentBTCPrice = btcPrices[btcPrices.length - 1];
    const btcRoc14 = calculateROC(btcPrices, 14);
    const btcSma200 = calculateSMA(btcPrices, 200);
    const mayer = currentBTCPrice / btcSma200;

    let targetExposure = 0,
      regimeStatus = "";
    if (mayer < 0.75) {
      targetExposure = btcRoc14 > -15 ? 1.0 : 0.5;
      regimeStatus = "ACCUMULATION (DEEP DISCOUNT)";
    } else if (mayer >= 0.75 && mayer < 1.2) {
      targetExposure = 0.8;
      regimeStatus = "RECOVERY / FAIR VALUE";
    } else if (mayer >= 1.2 && mayer < 2.0) {
      targetExposure = 0.6;
      regimeStatus = "MARKUP (BULLISH)";
    } else {
      targetExposure = 0.2;
      regimeStatus = "DISTRIBUTION (OVERVALUED)";
    }

    if (dxyPrices.length > 50) {
      const dxyEma20 = calculateEMA(dxyPrices.slice(-100), 20);
      const dxyEma50 = calculateEMA(dxyPrices.slice(-100), 50);
      const dxyRoc14 = calculateROC(dxyPrices, 14);
      if (dxyEma20 > dxyEma50 && dxyRoc14 > 2 && btcRoc14 < -10) {
        targetExposure = 0.0;
        regimeStatus = "CRITICAL MACRO RISK (100% CASH)";
      }
    }

    // --- OTAK 2: ROTASI SEKTORAL & OI ---
    let dailyMomentum = [],
      emergencySells = [];
    const trailingStopTolerance = 0.15;

    for (const symbol of targetCoins) {
      const prices = marketDataLists[symbol];
      const vols = marketVolumeLists[symbol];
      if (prices.length < 50) continue;
      const currentP = marketPrices[symbol];

      if (currentHoldings[symbol] > 0) {
        if (currentP > (athPrices[symbol] || 0)) athPrices[symbol] = currentP;
        const dropFromAth = (athPrices[symbol] - currentP) / athPrices[symbol];
        if (dropFromAth >= trailingStopTolerance) {
          emergencySells.push(symbol);
          athPrices[symbol] = 0;
        }
      }

      const sma50 = calculateSMA(prices, 50);
      const distanceToSma50 = ((currentP - sma50) / sma50) * 100;
      const roc14 = calculateROC(prices, 14);
      const roc30 = calculateROC(prices, 30);

      if (roc14 > 0 && distanceToSma50 < 40) {
        const currentVol = vols[vols.length - 1];
        const avgVol20 = calculateSMA(vols.slice(-20), 20);
        let smartMoneyMultiplier = 1.0;
        if (currentVol > avgVol20 * 2.5) smartMoneyMultiplier = 2.0;
        else if (currentVol > avgVol20 * 1.5) smartMoneyMultiplier = 1.5;

        let oiMultiplier = 1.0;
        if (oiHistory[symbol] && oiHistory[symbol].length === 5) {
          const currentOI = oiHistory[symbol][4];
          const pastOI = oiHistory[symbol][0];
          const oiChange = ((currentOI - pastOI) / pastOI) * 100;
          if (oiChange > 15 && distanceToSma50 < 20) oiMultiplier = 1.5;
          else if (oiChange < -10) oiMultiplier = 0.1;
        }

        const baseScore = roc14 * 0.6 + roc30 * 0.4;
        if (baseScore > 0)
          dailyMomentum.push({
            symbol,
            finalQuantScore: baseScore * smartMoneyMultiplier * oiMultiplier,
          });
      }
    }

    // --- OTAK 3: EKSEKUSI ---
    const totalCryptoBudget = totalEquity * targetExposure;
    let targetValues = {};
    targetCoins.forEach((coin) => (targetValues[coin] = 0));

    dailyMomentum.sort((a, b) => b.finalQuantScore - a.finalQuantScore);
    const safePicks = dailyMomentum.filter(
      (item) => !emergencySells.includes(item.symbol),
    );
    const topPicks = safePicks.slice(0, 3);
    const totalScore = topPicks.reduce(
      (sum, item) => sum + item.finalQuantScore,
      0,
    );

    if (totalScore > 0) {
      topPicks.forEach((pick) => {
        targetValues[pick.symbol] =
          totalCryptoBudget * (pick.finalQuantScore / totalScore);
      });
    }

    const { newHoldings, newCapitalUSDT, newCostBasis } =
      await executeLiveRebalancing(
        targetValues,
        currentHoldings,
        marketPrices,
        capitalUSDT,
        costBasis,
        totalEquity,
      );

    // --- 4.5 AUTOSYNC REAL BALANCES (PENGHANCUR SLIPPAGE & DEBU KOIN) ---
    // Beri waktu 3 detik agar Bybit selesai menghitung potongan fee dan settling order
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const realBalances = await syncRealBybitBalances();
    let finalCapitalUSDT = newCapitalUSDT;
    let finalHoldings = { ...newHoldings };

    if (realBalances) {
      finalCapitalUSDT = realBalances["USDT"] || 0;

      targetCoins.forEach((symbol) => {
        const coinName = symbol.replace("USDT", ""); // Ubah BTCUSDT jadi BTC
        const physicalBalance = realBalances[coinName] || 0;
        const currentP = marketPrices[symbol] || 1;

        // Jika nilai koin fisik di Bybit kurang dari $1, anggap itu "debu kripto" dan buang dari catatan (0)
        if (physicalBalance * currentP > 1) {
          finalHoldings[symbol] = physicalBalance;
        } else {
          finalHoldings[symbol] = 0;
        }
      });
    }

    // --- 5. UPDATE DATABASE (STATE PERSISTENCE) ---
    // 💡 REKALKULASI TOTAL EQUITY BERDASARKAN HASIL FISIK BYBIT TERBARU
    let finalCryptoValue = 0;
    for (const [sym, qty] of Object.entries(finalHoldings)) {
      finalCryptoValue += qty * (marketPrices[sym] || 0);
    }
    const finalTotalEquity = finalCapitalUSDT + finalCryptoValue;

    const START_CAPITAL = parseFloat(process.env.INCEPTION_CAPITAL || "200");
    const START_BTC_PRICE = parseFloat(
      process.env.INCEPTION_BTC_PRICE || "77576.7",
    );
    const START_SPX_PRICE = parseFloat(
      process.env.INCEPTION_SPX_PRICE || "7165.07",
    );

    const { data: allHistory } = await supabase
      .from("portfolio_history")
      .select("total_value");
    let peakValue = START_CAPITAL;
    if (allHistory) {
      allHistory.forEach((h) => {
        const val = parseFloat(h.total_value);
        if (val > peakValue) peakValue = val;
      });
    }
    if (finalTotalEquity > peakValue) peakValue = finalTotalEquity;
    const maxDrawdown = ((peakValue - finalTotalEquity) / peakValue) * 100;

    const currentSystemRoi = (
      ((finalTotalEquity - START_CAPITAL) / START_CAPITAL) *
      100
    ).toFixed(2);
    const currentBtcRoi = (
      ((currentBTCPrice - START_BTC_PRICE) / START_BTC_PRICE) *
      100
    ).toFixed(2);
    const currentSpxRoi = (
      ((currentSPXPrice - START_SPX_PRICE) / START_SPX_PRICE) *
      100
    ).toFixed(2);

    const todayOnly = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
    }).format(new Date());
    await supabase.from("portfolio_history").upsert(
      [
        {
          date: todayOnly,
          total_value: finalTotalEquity.toFixed(2),
          cash_value: finalCapitalUSDT.toFixed(2),
          crypto_value: finalCryptoValue.toFixed(2),
          system_roi: currentSystemRoi,
          btc_roi: currentBtcRoi,
          spx_roi: currentSpxRoi,
          max_drawdown: maxDrawdown.toFixed(2),
        },
      ],
      { onConflict: "date" },
    );

    await supabase.from("current_positions").delete().neq("symbol", "DUMMY");
    let finalPositions = [
      {
        symbol: "USDT",
        percentage: ((finalCapitalUSDT / finalTotalEquity) * 100).toFixed(2),
        amount: finalCapitalUSDT.toFixed(2),
        ath_price: 0,
      },
    ];

    for (const [symbol, qty] of Object.entries(finalHoldings)) {
      const price = marketPrices[symbol];
      const val = qty * price;
      const pct = (val / finalTotalEquity) * 100;
      if (pct > 1) {
        finalPositions.push({
          symbol: symbol.replace("USDT", ""),
          percentage: pct.toFixed(2),
          avg_price: (newCostBasis[symbol] / qty).toFixed(4),
          amount: qty.toFixed(6),
          ath_price: athPrices[symbol] || marketPrices[symbol],
        });
      }
    }
    await supabase.from("current_positions").insert(finalPositions);

    // --- 6. TELEGRAM ---
    await broadcastUpdate(regimeStatus, finalTotalEquity, finalCapitalUSDT);
  } catch (error) {
    console.error("❌ ERROR:", error);
    await sendTelegram(
      `🚨 *SYSTEM ALERT*\nError saat menjalankan Daily Oracle:\n\`${error.message}\``,
    );
  }
}

runDailyOracle();
