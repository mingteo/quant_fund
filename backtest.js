require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// --- 1. FUNGSI MATEMATIKA (UTILITIES) ---
function calculateEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
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

// --- 2. ENGINE BACKTEST UTAMA ---
async function runBacktest() {
  console.log("🚀 MEMULAI BACKTEST: VERSI QUANT BALANCED (GOLD)...");

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

  // A. Ambil Data Assets & Market
  const { data: assets } = await supabase
    .from("assets")
    .select("id, symbol")
    .in("symbol", targetCoins);
  const assetMap = new Map(assets.map((a) => [a.symbol, a.id]));

  let marketData = {};
  let marketVolume = {};

  for (const symbol of targetCoins) {
    const assetId = assetMap.get(symbol);
    if (!assetId) continue;

    const { data } = await supabase
      .from("market_data")
      .select("timestamp, close, volume")
      .eq("asset_id", assetId)
      .order("timestamp", { ascending: true });

    marketData[symbol] = new Map(
      data.map((item) => [item.timestamp, parseFloat(item.close)]),
    );

    marketVolume[symbol] = new Map(
      data.map((item) => [item.timestamp, parseFloat(item.volume)]),
    );
  }

  // B. Ambil Data Makro
  const { data: dxyData } = await supabase
    .from("macro_data")
    .select("timestamp, close")
    .eq("symbol", "DXY")
    .order("timestamp", { ascending: true });
  let dxyTimeline = dxyData
    ? dxyData.map((item) => ({
        dateOnly: new Date(item.timestamp).toISOString().split("T")[0],
        close: parseFloat(item.close),
      }))
    : [];

  const { data: spxData } = await supabase
    .from("macro_data")
    .select("timestamp, close")
    .eq("symbol", "SPX")
    .order("timestamp", { ascending: true });
  let spxTimeline = spxData
    ? spxData.map((item) => ({
        dateOnly: new Date(item.timestamp).toISOString().split("T")[0],
        close: parseFloat(item.close),
      }))
    : [];

  const { data: btcTimeline } = await supabase
    .from("market_data")
    .select("*")
    .eq("asset_id", assetMap.get("BTCUSDT"))
    .order("timestamp", { ascending: true });

  if (!btcTimeline || btcTimeline.length < 200) {
    console.error(
      "❌ ABORT: Data Market tidak cukup untuk Backtest (Butuh min 200 hari).",
    );
    console.log(
      "Saran: Pastikan fetchHistory.js berhasil mengisi market_data terlebih dahulu.",
    );
    return; // Hentikan script dengan sopan, bukan dengan error pecah
  }

  const { data: oiData } = await supabase
    .from("derivatives_data")
    .select("symbol, open_interest, timestamp")
    .order("timestamp", { ascending: true });

  let derivativesTimeline = {};
  if (oiData) {
    oiData.forEach((row) => {
      // Pastikan format symbol sama (misal: "BTCUSDT")
      const sym = row.symbol;
      if (!derivativesTimeline[sym]) derivativesTimeline[sym] = [];
      derivativesTimeline[sym].push({
        dateOnly: new Date(row.timestamp).toISOString().split("T")[0],
        oi: parseFloat(row.open_interest),
      });
    });
  }

  const startDate = btcTimeline[0].timestamp;

  // C. Inisialisasi Portofolio
  let capitalUSDT = 10000;
  let holdings = {};
  let costBasis = {};
  let athPrices = {};
  targetCoins.forEach((coin) => {
    holdings[coin] = 0;
    costBasis[coin] = 0;
    athPrices[coin] = 0;
  });
  let peakValue = 10000;
  let maxDrawdown = 0;
  let dailyRecords = [];
  let totalTrades = 0;

  const startIdx = 200;
  const startBTCPrice =
    marketData["BTCUSDT"]?.get(btcTimeline[startIdx].timestamp) || 1;
  const startSPXPrice =
    spxTimeline.find(
      (d) =>
        d.dateOnly >=
        new Date(btcTimeline[startIdx].timestamp).toISOString().split("T")[0],
    )?.close || 1;

  // --- 3. LOOPING SIMULASI HARIAN ---
  for (let i = startIdx; i < btcTimeline.length; i++) {
    const todayStr = btcTimeline[i].timestamp;
    const dateOnly = new Date(todayStr).toISOString().split("T")[0];

    const getPricesUpToToday = (symbol) => {
      let prices = [];
      for (let j = 0; j <= i; j++) {
        const time = btcTimeline[j].timestamp;
        if (marketData[symbol]?.has(time))
          prices.push(marketData[symbol].get(time));
      }
      return prices;
    };

    const btcPrices = getPricesUpToToday("BTCUSDT");
    if (btcPrices.length < 200) continue;
    const currentBTCPrice = btcPrices[btcPrices.length - 1];

    // TAHAP 1: HITUNG TOTAL EQUITY
    let currentCryptoValue = 0;
    for (const symbol of targetCoins) {
      const p = marketData[symbol]?.get(todayStr) || 0;
      currentCryptoValue += holdings[symbol] * p;
    }
    let currentPortfolioValue = capitalUSDT + currentCryptoValue;

    // =========================================================
    // TAHAP 2: SMART REGIME & EXPOSURE (QUANTITATIVE CONTRARIAN)
    // =========================================================
    const btcEma20 = calculateEMA(btcPrices.slice(-100), 20);
    const btcEma50 = calculateEMA(btcPrices.slice(-100), 50);
    const trendDirection = btcEma20 > btcEma50 ? "UPTREND" : "DOWNTREND";
    const btcRoc14 = calculateROC(btcPrices, 14); // Kecepatan pergerakan harga
    const btcSma200 = calculateSMA(btcPrices, 200);
    const mayer = currentBTCPrice / btcSma200;

    let targetExposure = 0;
    let regimeStatus = "";

    // 1. Model Akumulasi Contrarian berbasis Deviasi Historis (Mayer)
    if (mayer < 0.75) {
      // EXTREME FEAR / DEEP DISCOUNT
      // Harga hancur jauh di bawah SMA 200. Smart money beraksi di sini.
      // Syarat perlindungan: Beli agresif HANYA JIKA harga tidak sedang terjun bebas (ROC > -15)
      targetExposure = btcRoc14 > -15 ? 1.0 : 0.5;
      regimeStatus = "ACCUMULATION (DEEP DISCOUNT)";
    } else if (mayer >= 0.75 && mayer < 1.2) {
      // FAIR VALUE / EARLY RECOVERY
      targetExposure = 0.8;
      regimeStatus = "RECOVERY / FAIR VALUE";
    } else if (mayer >= 1.2 && mayer < 2.0) {
      // BULL MARKET ONGOING
      // Harga sudah naik di atas rata-rata. Kita mulai kurangi paparan risiko perlahan.
      targetExposure = 0.6;
      regimeStatus = "MARKUP (BULLISH)";
    } else if (mayer >= 2.0) {
      // OVERVALUED / EUPHORIA
      // Ritel FOMO, sistem kita mengamankan profit dan hanya menyisakan sedikit posisi.
      targetExposure = 0.2;
      regimeStatus = "DISTRIBUTION (OVERVALUED)";
    }

    // 2. The Smart Kill-Switch (Korelasi DXY & Momentum Crash)
    let alerts = [];
    const availableDXY = dxyTimeline
      .filter((d) => d.dateOnly <= dateOnly)
      .map((d) => d.close);

    if (availableDXY.length > 50) {
      const dxyEma20 = calculateEMA(availableDXY.slice(-100), 20);
      const dxyEma50 = calculateEMA(availableDXY.slice(-100), 50);
      const dxyRoc14 = calculateROC(availableDXY, 14);

      // LOGIKA KILL-SWITCH: DXY meroket tajam DAN Bitcoin kehilangan momentum (darah tumpah)
      if (dxyEma20 > dxyEma50 && dxyRoc14 > 2 && btcRoc14 < -10) {
        targetExposure = 0.0; // 100% CASH. Tarik semua pasukan dari pasar.
        regimeStatus = "CRITICAL MACRO RISK (100% CASH)";
        alerts.push("DXY SPIKE + BTC CRASH DETECTED");
      }
    }

    // =========================================================
    // TAHAP 3: RANKING MOMENTUM & ROTASI SEKTORAL PRESISI
    // =========================================================

    // Helper untuk menarik array volume sejajar dengan timeline
    const getVolumesUpToToday = (symbol) => {
      let vols = [];
      for (let j = 0; j <= i; j++) {
        const time = btcTimeline[j].timestamp;
        if (marketVolume[symbol]?.has(time))
          vols.push(marketVolume[symbol].get(time));
      }
      return vols;
    };

    let dailyMomentum = [];
    for (const symbol of targetCoins) {
      const prices = getPricesUpToToday(symbol);
      const vols = getVolumesUpToToday(symbol);

      if (prices.length < 50 || vols.length < 50) continue;

      const currentP = prices[prices.length - 1];
      const sma50 = calculateSMA(prices, 50);
      const distanceToSma50 = ((currentP - sma50) / sma50) * 100;

      const roc14 = calculateROC(prices, 14);
      const roc30 = calculateROC(prices, 30);

      // Gatekeeper: Harus uptrend ringan, tidak boleh pucuk
      if (roc14 > 0 && distanceToSma50 < 40) {
        // 🚨 RADAR SMART MONEY: Deteksi Anomali Volume
        const currentVol = vols[vols.length - 1];
        const avgVol20 = calculateSMA(vols.slice(-20), 20); // Rata-rata volume 20 hari terakhir

        let smartMoneyMultiplier = 1.0;

        // Jika volume hari ini 1.5x lipat dari rata-rata (Lonjakan 50%)
        if (currentVol > avgVol20 * 1.5) {
          smartMoneyMultiplier = 1.5; // Beri bobot ekstra 50% pada skor
        }
        // Jika volume meledak lebih dari 2.5x lipat (Whale masuk skala masif)
        else if (currentVol > avgVol20 * 2.5) {
          smartMoneyMultiplier = 2.0; // Beri bobot ganda! Sistem akan agresif masuk ke koin ini
        }

        let oiMultiplier = 1.0;
        const availableOI =
          derivativesTimeline[symbol]
            ?.filter((d) => d.dateOnly <= dateOnly)
            .map((d) => d.oi) || [];

        // Hanya hitung jika kita punya histori OI setidaknya 5 hari ke belakang
        if (availableOI.length >= 5) {
          const currentOI = availableOI[availableOI.length - 1];
          const pastOI = availableOI[availableOI.length - 5];
          const oiChange = ((currentOI - pastOI) / pastOI) * 100;

          if (oiChange > 15 && distanceToSma50 < 20) {
            // WHALE ACCUMULATION: OI naik drastis >15% tapi harga masih di bawah/sideways
            oiMultiplier = 1.5; // Beri sinyal beli super kuat!
          } else if (oiChange < -10) {
            // WHALE DISTRIBUTION: OI anjlok >10% (Whale tutup posisi massal)
            oiMultiplier = 0.1; // Matikan skor koin ini, bahaya dump mengintai!
          }
        }

        // Kalkulasi Quant Score Akhir (Momentum x Volume x Open Interest)
        const baseScore = roc14 * 0.6 + roc30 * 0.4;

        if (baseScore > 0) {
          // Pengganda gabungan akan membuat koin dengan sinyal on-chain terkuat mendominasi portofolio
          const finalQuantScore =
            baseScore * smartMoneyMultiplier * oiMultiplier;
          dailyMomentum.push({ symbol, finalQuantScore });
        }
      }
    }

    // Eksekusi: Ambil maksimal 3 Koin dengan skor kuantitatif tertinggi
    dailyMomentum.sort((a, b) => b.finalQuantScore - a.finalQuantScore);
    const topSymbols = dailyMomentum.slice(0, 3).map((c) => c.symbol);

    let actionLog = [];

    // =========================================================
    // TAHAP 3.5: THE PROFIT LOCKER (DYNAMIC TRAILING STOP-LOSS)
    // =========================================================
    // Parameter: Berapa % harga boleh turun dari pucuk lokal sebelum cut-loss/take-profit paksa?
    const trailingStopTolerance = 0.15; // Setelan 15% (bisa disesuaikan dengan agresivitasmu)
    let emergencySells = [];

    for (const symbol of targetCoins) {
      if (holdings[symbol] > 0) {
        const currentPrice = marketData[symbol]?.get(todayStr);

        // 1. Update Rekor Harga Tertinggi (ATH) Lokal selama memegang barang
        if (currentPrice > athPrices[symbol]) {
          athPrices[symbol] = currentPrice;
        }

        // 2. Cek apakah harga jatuh melewati batas toleransi dari ATH lokal
        const dropFromAth =
          (athPrices[symbol] - currentPrice) / athPrices[symbol];
        if (dropFromAth >= trailingStopTolerance) {
          emergencySells.push(symbol);
          actionLog.push(`🚨 TS-TRIGGER: ${symbol.replace("USDT", "")}`);
          athPrices[symbol] = 0; // Reset memori ATH karena kita akan membuang barangnya
        }
      } else {
        athPrices[symbol] = 0; // Pastikan reset ke 0 jika kita sedang tidak memegang barangnya
      }
    }

    // =========================================================
    // TAHAP 4: ASYMMETRIC REBALANCING (SAFETY FIRST)
    // =========================================================
    const totalCryptoBudget = currentPortfolioValue * targetExposure;
    let dayHasTrades = false;

    // 1. Reset target
    let targetValues = {};
    targetCoins.forEach((coin) => (targetValues[coin] = 0));

    // 2. Pembobotan Asimetris Berdasarkan Dominasi Momentum
    if (targetExposure > 0 && dailyMomentum.length > 0) {
      // 🛡️ PERUBAHAN KRUSIAL: Singkirkan koin yang terkena Stop-Loss hari ini dari radar pembelian
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
          const weight = pick.finalQuantScore / totalScore;
          targetValues[pick.symbol] = totalCryptoBudget * weight;
        });
      }
    }

    // 3. FASE 1: EKSEKUSI SELL (JUAL) LEBIH DULU
    // Kita harus mengamankan USDT sebelum bisa dirotasi ke koin pemenang
    for (const symbol of targetCoins) {
      const currentPrice = marketData[symbol]?.get(todayStr);
      if (!currentPrice) continue;

      const currentVal = holdings[symbol] * currentPrice;
      const targetVal = targetValues[symbol];
      const diff = targetVal - currentVal;

      if (diff < -50) {
        // SAFETY CLAMP 1: Jangan jual lebih dari kuantitas aset yang kita punya!
        const sellQty = Math.min(
          Math.abs(diff) / currentPrice,
          holdings[symbol],
        );

        if (holdings[symbol] > 0) {
          const ratio = sellQty / holdings[symbol];
          costBasis[symbol] -= costBasis[symbol] * ratio;
        }

        capitalUSDT += sellQty * currentPrice;
        holdings[symbol] -= sellQty;
        actionLog.push(`-${symbol.replace("USDT", "")}`);
        dayHasTrades = true;
      }
    }

    // 4. FASE 2: EKSEKUSI BUY (BELI) SETELAH USDT TERSEDIA
    for (const symbol of targetCoins) {
      const currentPrice = marketData[symbol]?.get(todayStr);
      if (!currentPrice) continue;

      const currentVal = holdings[symbol] * currentPrice;
      const targetVal = targetValues[symbol];
      const diff = targetVal - currentVal;

      if (diff > 50) {
        // SAFETY CLAMP 2: Jangan beli melebihi USDT riil yang ada di dompet!
        const buyAmount = Math.min(diff, capitalUSDT);

        if (buyAmount > 10) {
          // Lewati debu transaksi (dust)
          capitalUSDT -= buyAmount;
          holdings[symbol] += buyAmount / currentPrice;
          costBasis[symbol] += buyAmount;
          actionLog.push(`+${symbol.replace("USDT", "")}`);
          dayHasTrades = true;
          totalTrades++; // Hitung sebagai trade baru
        }
      }
    }

    // TAHAP 5: LOG HARIAN (DI DALAM LOOP)
    if (dayHasTrades) {
      console.log(`\n=========================================`);
      console.log(`🗓️  [${dateOnly}] ORACLE PORTFOLIO UPDATE`);
      console.log(
        `📈 Market: ${regimeStatus} (${trendDirection}) | Mayer: ${mayer.toFixed(2)}x`,
      );
      console.log(
        `🔄 Aksi  : ${actionLog.join(", ")} | Exp: ${(targetExposure * 100).toFixed(0)}%`,
      );
      console.log(
        `💰 Equity: $${currentPortfolioValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
      );
      console.log(`\nCurrent Holdings:`);

      targetCoins.forEach((symbol) => {
        const currentPrice = marketData[symbol]?.get(todayStr);
        const val = holdings[symbol] * currentPrice;
        const pct = (val / currentPortfolioValue) * 100;

        if (pct > 0.5) {
          // HITUNG AVG PRICE
          const avgPrice = costBasis[symbol] / holdings[symbol];
          const pnlPct = ((currentPrice - avgPrice) / avgPrice) * 100;

          console.log(
            `${pct.toFixed(1).padStart(5)}% Spot $${symbol.replace("USDT", "").padEnd(5)} ` +
              `($${avgPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} avg) ` +
              `[${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%]`,
          );
        }
      });

      const cashPct = (capitalUSDT / currentPortfolioValue) * 100;
      console.log(`${cashPct.toFixed(1).padStart(5)}% Cash (USDT)`);
      console.log(`=========================================`);
    }

    // TAHAP 6: RECORDING
    if (currentPortfolioValue > peakValue) peakValue = currentPortfolioValue;
    const currentDD = ((peakValue - currentPortfolioValue) / peakValue) * 100;
    if (currentDD > maxDrawdown) maxDrawdown = currentDD;

    const currentSPXPrice =
      spxTimeline.filter((d) => d.dateOnly <= dateOnly).pop()?.close ||
      startSPXPrice;

    dailyRecords.push({
      date: dateOnly,
      total_value: currentPortfolioValue.toFixed(2),
      cash_value: capitalUSDT.toFixed(2),
      crypto_value: (currentPortfolioValue - capitalUSDT).toFixed(2),
      system_roi: (((currentPortfolioValue - 10000) / 10000) * 100).toFixed(2),
      btc_roi: (
        ((currentBTCPrice - startBTCPrice) / startBTCPrice) *
        100
      ).toFixed(2),
      spx_roi: (
        ((currentSPXPrice - startSPXPrice) / startSPXPrice) *
        100
      ).toFixed(2),
      max_drawdown: maxDrawdown.toFixed(2),
    });
  }

  // --- 4. PENYIMPANAN DATA (SYNC) ---
  console.log("\n📊 MENGIRIM DATA KE SUPABASE...");
  const chunkSize = 500;
  for (let i = 0; i < dailyRecords.length; i += chunkSize) {
    const chunk = dailyRecords.slice(i, i + chunkSize);
    await supabase
      .from("portfolio_history")
      .upsert(chunk, { onConflict: "date" });
  }

  // B. Simpan Rincian Posisi Terakhir
  await supabase.from("current_positions").delete().neq("symbol", "DUMMY");
  const lastRecord = dailyRecords[dailyRecords.length - 1];
  const lastDateStr = btcTimeline[btcTimeline.length - 1].timestamp;
  let finalPositions = [
    {
      symbol: "USDT",
      percentage: (
        (parseFloat(lastRecord.cash_value) /
          parseFloat(lastRecord.total_value)) *
        100
      ).toFixed(2),
    },
  ];

  for (const symbol of targetCoins) {
    const price = marketData[symbol].get(lastDateStr);
    const val = holdings[symbol] * price;
    const pct = (val / parseFloat(lastRecord.total_value)) * 100;
    if (pct > 1)
      finalPositions.push({
        symbol: symbol.replace("USDT", ""),
        percentage: pct.toFixed(2),
        avg_price: (costBasis[symbol] / holdings[symbol]).toFixed(4),
      });
  }
  await supabase.from("current_positions").insert(finalPositions);

  // --- KESIMPULAN AKHIR ---
  const finalValue = parseFloat(lastRecord.total_value);
  const totalROI = parseFloat(lastRecord.system_roi);
  const finalBTCROI = parseFloat(lastRecord.btc_roi);
  const finalSPXROI = parseFloat(lastRecord.spx_roi);

  console.log(
    `\n╔════════════════════════════════════════════════════════════╗`,
  );
  console.log(`║          🏆 HASIL AKHIR BACKTEST (QUANT GOLD)              ║`);
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  console.log(`   💰 Modal Awal          : $10,000.00                        `);
  console.log(
    `   💵 Nilai Akhir         : $${finalValue.toFixed(2).padStart(12)}               `,
  );
  console.log(
    `   🚀 Total Trades        : ${totalTrades.toString().padStart(12)} trades             `,
  );
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  console.log(
    `   📈 Return Sistem (ROI) : ${totalROI.toFixed(2).padStart(12)}%                `,
  );
  console.log(
    `   📉 Max Drawdown        : -${maxDrawdown.toFixed(2).padStart(11)}%                `,
  );
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  console.log(`║  📊 BENCHMARK COMPARISON:                                  ║`);
  console.log(
    `   🔸 Bitcoin Buy & Hold  : ${finalBTCROI.toFixed(2).padStart(12)}%                 `,
  );
  console.log(
    `   🔹 S&P 500 (Stock)     : ${finalSPXROI.toFixed(2).padStart(12)}%                 `,
  );
  console.log(
    `╚════════════════════════════════════════════════════════════╝\n`,
  );
}

runBacktest();
