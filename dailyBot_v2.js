require("dotenv").config();
const { execSync } = require("child_process");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

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
  "PAXGUSDT",
];

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

// 🌟 UPGRADE 1: HISTORICAL VOLATILITY (Pengganti ATR untuk Dynamic Stop-Loss)
function calculateVolatility(prices, period) {
  if (prices.length < period) return 0.15; // Default 15%
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance =
    slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const stdev = Math.sqrt(variance);

  let volPct = stdev / mean;
  // Batas rasional: Stop-Loss minimal 8%, maksimal 25%
  if (volPct < 0.08) volPct = 0.08;
  if (volPct > 0.25) volPct = 0.25;
  return volPct;
}

// ====================================================================
// 2. MAIN ORCHESTRATOR (STAGING / DRY-RUN MODE)
// ====================================================================
async function runStagingOracle() {
  console.log("=================================================");
  console.log("🚀 MENGAKTIFKAN QUANT ORACLE V2 (STAGING MODE)...");
  console.log("=================================================");
  console.log(
    "⚠️ API Bybit & Telegram NONAKTIF. Ini adalah simulasi Dry-Run.\n",
  );

  // --- 0. DATA PIPELINE TRIGGER (AUTO-FETCH) ---
  console.log("🔄 Memperbarui seluruh instrumen data pipeline...");
  try {
    console.log("-> 1/3: Menarik data harga pasar...");
    execSync("node fetchHistory.js", { stdio: "ignore" }); // 'ignore' agar terminal tidak terlalu kotor
    console.log("-> 2/3: Menarik data makro DXY & SPX...");
    execSync("node fetchMacro.js", { stdio: "ignore" });
    console.log("-> 3/3: Menarik data Open Interest...");
    execSync("node fetchDerivatives.js", { stdio: "ignore" });
    console.log("✅ Database diperbarui! Memulai kalkulasi otak Oracle...\n");
  } catch (error) {
    console.log(
      "⚠️ Gagal fetch data baru, menggunakan data terakhir di Supabase.",
    );
  }

  try {
    // --- AMBIL PORTFOLIO DARI SUPABASE ---
    const { data: dbPositions } = await supabase
      .from("current_positions")
      .select("*");
    let currentHoldings = {},
      costBasis = {},
      athPrices = {};
    let capitalUSDT = 200; // Default fallback

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

    // --- OTAK 2: ROTASI SEKTORAL, RELATIVE STRENGTH, & DYNAMIC STOP ---
    let dailyMomentum = [],
      emergencySells = [];

    // 🌟 UPGRADE 3: DYNAMIC HYSTERESIS (Berbasis Sisa Cash)
    const cashRatio = capitalUSDT / totalEquity;
    let dynamicHysteresisPct = 0.05;
    if (cashRatio > 0.5)
      dynamicHysteresisPct = 0.03; // Agresif jika cash banyak
    else if (cashRatio < 0.2) dynamicHysteresisPct = 0.08; // Hemat fee jika cash tipis
    const rebalanceThreshold = totalEquity * dynamicHysteresisPct;

    for (const symbol of targetCoins) {
      const prices = marketDataLists[symbol];
      const vols = marketVolumeLists[symbol];
      if (prices.length < 50) continue;
      const currentP = marketPrices[symbol];

      // 🌟 UPGRADE 1 (Lanjutan): DYNAMIC VOLATILITY STOP-LOSS
      const dynamicStopTolerance = calculateVolatility(prices, 14);

      if (currentHoldings[symbol] > 0) {
        if (currentP > (athPrices[symbol] || 0)) athPrices[symbol] = currentP;
        const dropFromAth = (athPrices[symbol] - currentP) / athPrices[symbol];

        if (dropFromAth >= dynamicStopTolerance) {
          emergencySells.push(symbol);
          console.log(
            `🚨 THE GUILLOTINE JATUH: ${symbol} turun ${(dropFromAth * 100).toFixed(2)}% (Batas Volatilitas: ${(dynamicStopTolerance * 100).toFixed(2)}%)`,
          );
        }
      }

      const sma50 = calculateSMA(prices, 50);
      const distanceToSma50 = ((currentP - sma50) / sma50) * 100;
      const roc14 = calculateROC(prices, 14);
      const roc30 = calculateROC(prices, 30);

      // 🌟 UPGRADE 2: RELATIVE STRENGTH VS BTC
      const relativeStrengthVsBtc = roc14 - btcRoc14;

      if (
        roc14 > 0 &&
        (relativeStrengthVsBtc > 0 || symbol === "BTCUSDT") &&
        distanceToSma50 < 40
      ) {
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

        const baseScore =
          roc14 * 0.5 + roc30 * 0.3 + relativeStrengthVsBtc * 0.2;

        if (baseScore > 0) {
          // 🛡️ THE INCUMBENT ADVANTAGE (SABUK PENGAMAN 15%)
          let incumbentMultiplier = 1.0;
          const currentVal = (currentHoldings[symbol] || 0) * currentP;

          // Hanya berikan bonus 15% jika kita sedang memegang koin ini (bukan sekadar debu koin < $10)
          if (currentVal > 10) {
            incumbentMultiplier = 1.15;
          }

          dailyMomentum.push({
            symbol,
            // Kalikan semua multiplier, termasuk bonus petahana
            finalQuantScore:
              baseScore *
              smartMoneyMultiplier *
              oiMultiplier *
              incumbentMultiplier,
            rsBtc: relativeStrengthVsBtc,
            isIncumbent: incumbentMultiplier > 1.0, // Tandai untuk log terminal
          });
        }
      }
    }

    // --- OTAK 3: TARGET ALLOCATION (SIMULASI) ---
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

    // --- TERMINAL REPORT ---
    console.log("=================================================");
    console.log(`📊 STATUS PORTFOLIO SAAT INI`);
    console.log(`• Total Equity : $${totalEquity.toFixed(2)}`);
    console.log(
      `• Cash Reserve : $${capitalUSDT.toFixed(2)} (Ratio: ${(cashRatio * 100).toFixed(1)}%)`,
    );
    console.log(`• Macro Regime : ${regimeStatus}`);
    console.log(`• Tgt Exposure : ${(targetExposure * 100).toFixed(0)}%`);
    console.log(
      `• Dyn. Hysteresis: ${(dynamicHysteresisPct * 100).toFixed(1)}% (Minimal Rebalance: $${rebalanceThreshold.toFixed(2)})`,
    );
    console.log("-------------------------------------------------");

    console.log(`🏆 TOP 3 KOIN (Relative Strength > BTC)`);
    if (topPicks.length === 0)
      console.log("⚠️ Tidak ada koin yang memenuhi syarat. 100% Cash.");

    topPicks.forEach((p, idx) => {
      // Munculkan ikon tameng jika koin ini mendapatkan bonus Petahana
      const petahanaStatus = p.isIncumbent ? "🛡️ [INCUMBENT +15%]" : "";

      console.log(
        `${idx + 1}. ${p.symbol} | Score: ${p.finalQuantScore.toFixed(2)} ${petahanaStatus} | RS vs BTC: +${p.rsBtc.toFixed(2)}% | Target: $${targetValues[p.symbol].toFixed(2)}`,
      );
    });
    console.log("-------------------------------------------------");

    console.log(`🤖 SIMULASI EKSEKUSI (DRY RUN)`);
    let isActionNeeded = false;
    for (const symbol of Object.keys(targetValues)) {
      const currentPrice = marketPrices[symbol];
      const currentVal = (currentHoldings[symbol] || 0) * (currentPrice || 1);
      const targetVal = targetValues[symbol];
      const diff = targetVal - currentVal;

      if (
        Math.abs(diff) > rebalanceThreshold ||
        (targetVal === 0 && currentVal > 10)
      ) {
        isActionNeeded = true;
        const action = diff > 0 ? "BUY" : "SELL";
        console.log(
          `[ACTION] ${action} ${symbol} | Perubahan senilai: $${Math.abs(diff).toFixed(2)}`,
        );
      }
    }

    if (!isActionNeeded) {
      console.log(
        `🛡️ PERISAI AKTIF: Perubahan target di bawah batas Hysteresis ($${rebalanceThreshold.toFixed(2)}). Tidak ada transaksi.`,
      );
    }
    console.log("=================================================\n");
  } catch (error) {
    console.error("❌ ERROR SAAT SIMULASI:", error);
  }
}

runStagingOracle();
