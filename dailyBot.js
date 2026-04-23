require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// Gunakan Service Role Key jika ada untuk menghindari limitasi RLS saat Insert/Update
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ====================================================================
// 1. MODUL TELEGRAM BROADCAST
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

async function broadcastUpdate() {
  console.log("📢 PREPARING QUANT ORACLE BROADCAST...");

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

  const totalVal = parseFloat(last.total_value);
  const cashVal = parseFloat(last.cash_value);
  const cryptoVal = parseFloat(last.crypto_value);
  const cryptoExposurePct = ((cryptoVal / totalVal) * 100).toFixed(1);

  const filledBoxes = Math.round(cryptoExposurePct / 10);
  const exposureBar = "🟩".repeat(filledBoxes) + "⬜".repeat(10 - filledBoxes);

  let message = `🏛 *QUANT ORACLE TERMINAL*\n`;
  message += `_Daily Execution: ${new Date().toLocaleString("id-ID")}_\n\n`;

  message += `🛡️ *SYSTEM EXPOSURE*\n`;
  message += `[${exposureBar}] *${cryptoExposurePct}%*\n`;
  message += `• Crypto Assets: *$${cryptoVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}*\n`;
  message += `• Cash Reserve : *$${cashVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}*\n\n`;

  message += `💰 *EQUITY & PERFORMANCE*\n`;
  message += `• Total Capital: *$${totalVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}*\n`;
  message += `• System ROI : *${last.system_roi}%*\n`;
  message += `• Max Drawdown: \`${last.max_drawdown}%\`\n\n`;

  message += `📊 *ACTIVE ALLOCATIONS*\n`;
  let hasCrypto = false;
  positions.forEach((p) => {
    if (p.symbol === "USDT") return;
    hasCrypto = true;
    const isWhaleTarget = parseFloat(p.percentage) > 20 ? "🐋" : "⚡";
    message += `${isWhaleTarget} *${p.symbol}*: ${p.percentage}% _(@ $${parseFloat(p.avg_price).toLocaleString(undefined, { maximumFractionDigits: 4 })})_\n`;
  });

  if (!hasCrypto) {
    message += `⚠️ _100% CASH MODE ACTIVE (Awaiting Macro Clear)_\n`;
  }

  message += `\n📈 *ALPHA (VS BENCHMARK)*\n`;
  message += `• System : ${last.system_roi}%\n`;
  message += `• Bitcoin: ${last.btc_roi}%\n`;
  message += `• S&P 500: ${last.spx_roi}%\n\n`;

  const alpha = parseFloat(last.system_roi) - parseFloat(last.btc_roi);
  const status =
    alpha > 0
      ? `✅ BEATING MARKET BY +${alpha.toFixed(2)}%`
      : `⚠️ UNDERPERFORMING BTC BY ${alpha.toFixed(2)}%`;

  message += `*STATUS:* ${status}\n\n`;
  message += `🔗 [Dashboard Link](https://your-dashboard-url.vercel.app/)`; // Jangan lupa ganti URL-nya jika sudah di-deploy

  await sendTelegram(message);
  console.log("✅ BROADCAST SENT!");
}

// ====================================================================
// 2. MODUL AUDIT & EXECUTION (WAKTU REAL-TIME & HYSTERESIS)
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

  const { error } = await supabase.from("trade_history").insert([
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

  if (error)
    console.error(`❌ Gagal mencatat audit ${type} ${symbol}:`, error.message);
  else
    console.log(`✅ Audit tercatat: ${type} ${symbol} pada ${executionTime}`);
}

async function executeLiveRebalancing(
  targetValues,
  currentHoldings,
  marketPrices,
  capitalUSDT,
  costBasis,
) {
  console.log("\n🤖 MEMULAI ORACLE LIVE REBALANCING...");
  const serverTimeMs = Date.now();
  let currentCryptoValue = 0;

  for (const [symbol, amount] of Object.entries(currentHoldings)) {
    currentCryptoValue += amount * (marketPrices[symbol] || 0);
  }
  const totalEquity = capitalUSDT + currentCryptoValue;

  // 🔥 HYSTERESIS THRESHOLD: 5% dari total portofolio
  const rebalanceThreshold = totalEquity * 0.05;
  console.log(
    `🛡️ Hysteresis Aktif: Toleransi pergerakan alokasi $${rebalanceThreshold.toFixed(2)}`,
  );

  let isSellExecuted = false;
  let newCapitalUSDT = capitalUSDT;
  let newHoldings = { ...currentHoldings };
  let newCostBasis = { ...costBasis };

  // --- FASE 1: EKSEKUSI SELL ---
  for (const symbol of Object.keys(targetValues)) {
    const currentPrice = marketPrices[symbol];
    if (!currentPrice) continue;

    const currentVal = newHoldings[symbol] * currentPrice;
    const targetVal = targetValues[symbol];
    const diff = targetVal - currentVal;

    if (diff < -rebalanceThreshold || (targetVal === 0 && currentVal > 10)) {
      const sellQty = Math.min(
        Math.abs(diff) / currentPrice,
        newHoldings[symbol],
      );

      if (sellQty > 0) {
        let avgPrice = 0;
        let pnl_percent = 0;
        if (newHoldings[symbol] > 0) {
          avgPrice = newCostBasis[symbol] / newHoldings[symbol];
          pnl_percent = ((currentPrice - avgPrice) / avgPrice) * 100;
        }

        const liveSellTime = new Date(serverTimeMs).toISOString(); // Waktu Real-Time Detik Ini
        await recordTrade(
          symbol,
          "SELL",
          currentPrice,
          sellQty,
          pnl_percent,
          liveSellTime,
        );

        // Update State Sementara
        const ratio = sellQty / newHoldings[symbol];
        newCostBasis[symbol] -= newCostBasis[symbol] * ratio;
        newCapitalUSDT += sellQty * currentPrice;
        newHoldings[symbol] -= sellQty;
        isSellExecuted = true;
      }
    }
  }

  // --- FASE 2: EKSEKUSI BUY ---
  for (const symbol of Object.keys(targetValues)) {
    const currentPrice = marketPrices[symbol];
    if (!currentPrice) continue;

    const currentVal = newHoldings[symbol] * currentPrice;
    const targetVal = targetValues[symbol];
    const diff = targetVal - currentVal;

    if (diff > rebalanceThreshold) {
      const buyAmount = Math.min(diff, newCapitalUSDT);

      if (buyAmount > 10) {
        const buyQty = buyAmount / currentPrice;

        // Waktu Real-Time + Jeda 1.5 detik agar BUY tercatat SETELAH SELL
        const delayMs = isSellExecuted ? 1500 : 0;
        const liveBuyTime = new Date(serverTimeMs + delayMs).toISOString();

        await recordTrade(symbol, "BUY", currentPrice, buyQty, 0, liveBuyTime);

        // Update State Sementara
        newCapitalUSDT -= buyAmount;
        newHoldings[symbol] = (newHoldings[symbol] || 0) + buyQty;
        newCostBasis[symbol] = (newCostBasis[symbol] || 0) + buyAmount;
      }
    }
  }

  return { newHoldings, newCapitalUSDT, newCostBasis, totalEquity };
}

// ====================================================================
// 3. MAIN BOT ORCHESTRATOR
// ====================================================================
async function runDailyOracle() {
  console.log("🚀 MENGAKTIFKAN QUANT ORACLE...");

  try {
    // 1. AMBIL POSISI SAAT INI DARI DATABASE
    const { data: dbPositions } = await supabase
      .from("current_positions")
      .select("*");
    let currentHoldings = {};
    let costBasis = {};
    let capitalUSDT = 10000; // Default jika DB kosong

    if (dbPositions) {
      dbPositions.forEach((p) => {
        if (p.symbol === "USDT") {
          // Untuk USDT, kita perlu mengambil nilainya dari portfolio_history terbaru
          // Namun sementara kita bisa set dari logic database Anda
        } else {
          const qty = parseFloat(p.amount || 0);
          currentHoldings[p.symbol + "USDT"] = qty;
          costBasis[p.symbol + "USDT"] = qty * parseFloat(p.avg_price || 0);
        }
      });
      // Ambil Capital USDT dari portfolio_history terbaru
      const { data: hist } = await supabase
        .from("portfolio_history")
        .select("cash_value")
        .order("date", { ascending: false })
        .limit(1);
      if (hist && hist.length > 0) capitalUSDT = parseFloat(hist[0].cash_value);
    }

    // 2. AMBIL HARGA MARKET TERBARU (Gunakan API Exchange / CryptoCompare / Database)
    // --- MASUKKAN LOGIKA FETCH HARGA ANDA DI SINI ---
    // Simulasi Market Prices (Anda harus menggantinya dengan fetch harga asli)
    const marketPrices = {
      BTCUSDT: 65000,
      SOLUSDT: 150,
      SUIUSDT: 1.5,
      // ...
    };

    // 3. JALANKAN LOGIKA QUANTITATIVE (MOMENTUM / BIAS) UNTUK MENDAPATKAN TARGET ALOKASI
    // --- MASUKKAN LOGIKA MENGHITUNG TARGET DI SINI ---
    // Simulasi Target (Misal: Sinyal mengatakan masuk BTC $4000, SOL $2000, sisanya Cash)
    const targetValues = {
      BTCUSDT: 4000,
      SOLUSDT: 2000,
      SUIUSDT: 0, // 0 berarti Exit/Jual
    };

    // 4. EKSEKUSI REBALANCING LIVE
    const { newHoldings, newCapitalUSDT, newCostBasis, totalEquity } =
      await executeLiveRebalancing(
        targetValues,
        currentHoldings,
        marketPrices,
        capitalUSDT,
        costBasis,
      );

    // 5. UPDATE DATABASE (CURRENT POSITIONS & PORTFOLIO HISTORY)
    // Update portfolio_history (Simpan nilai hari ini)
    const todayOnly = new Date().toISOString().split("T")[0];
    await supabase.from("portfolio_history").upsert(
      [
        {
          date: todayOnly,
          total_value: totalEquity.toFixed(2),
          cash_value: newCapitalUSDT.toFixed(2),
          crypto_value: (totalEquity - newCapitalUSDT).toFixed(2),
          system_roi: (((totalEquity - 10000) / 10000) * 100).toFixed(2),
          // ... hitung btc_roi, spx_roi, max_drawdown sesuai histori
        },
      ],
      { onConflict: "date" },
    );

    // Update current_positions
    await supabase.from("current_positions").delete().neq("symbol", "DUMMY"); // Clear table

    let finalPositions = [
      {
        symbol: "USDT",
        percentage: ((newCapitalUSDT / totalEquity) * 100).toFixed(2),
        amount: newCapitalUSDT.toFixed(2),
      },
    ];

    for (const [symbol, qty] of Object.entries(newHoldings)) {
      const price = marketPrices[symbol];
      const val = qty * price;
      const pct = (val / totalEquity) * 100;
      if (pct > 1) {
        // Hanya catat jika di atas 1% portofolio
        finalPositions.push({
          symbol: symbol.replace("USDT", ""),
          percentage: pct.toFixed(2),
          avg_price: (newCostBasis[symbol] / qty).toFixed(4),
          amount: qty.toFixed(6),
        });
      }
    }
    await supabase.from("current_positions").insert(finalPositions);

    // 6. KIRIM TELEGRAM BROADCAST
    // Jalankan broadcast HANYA setelah DB selesai di-update agar data yang terkirim akurat
    await broadcastUpdate();
  } catch (error) {
    console.error("❌ ERROR FATAL DALAM EKSEKUSI DAILY BOT:", error);
    await sendTelegram(
      `🚨 *SYSTEM ALERT*\nTerjadi error saat menjalankan Daily Oracle:\n\`${error.message}\``,
    );
  }
}

runDailyOracle();
