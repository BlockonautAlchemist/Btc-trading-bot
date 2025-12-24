import axios from "axios";

export interface SpotStats {
  price: number;
  change24hPct: number;
  volume24h: number;
  high24h?: number;
  low24h?: number;
}

export type TrendDirection = "UP" | "DOWN" | "RANGE";

export interface DerivedIndicators {
  emaShort: number;
  emaLong: number;
  trendDirection: TrendDirection;
  trendStrengthPct: number;
  volatility24hPct: number;
  volumeTrend24hPct: number | null;
}

export interface BtcIndicators {
  spot: SpotStats;
  derived: DerivedIndicators;
}

const cg = axios.create({
  baseURL: "https://api.coingecko.com/api/v3",
  headers: {
    "x-cg-demo-api-key": process.env.COINGECKO_API_KEY || "",
  },
  timeout: 10000,
});
const requireNumber = (value: unknown, label: string): number => {
  const num = typeof value === "string" ? parseFloat(value) : Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Missing or invalid numeric value for ${label}`);
  }
  return num;
};

function computeEma(values: number[], period: number): number {
  if (values.length === 0) {
    throw new Error("Cannot compute EMA of empty array");
  }
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeStdDevPct(values: number[]): number {
  if (values.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    if (prev !== 0) {
      returns.push(((curr - prev) / prev) * 100);
    }
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) * (r - mean), 0) /
    returns.length;
  return Math.sqrt(variance);
}

export const fetchBtcIndicators = async (): Promise<BtcIndicators> => {
  try {
    const { data: coinData } = await cg.get("/coins/bitcoin", {
      params: {
        localization: "false",
        tickers: "false",
        market_data: "true",
        community_data: "false",
        developer_data: "false",
        sparkline: "false",
      },
    });

    const market = coinData?.market_data;
    if (!market) {
      throw new Error("No market_data in CoinGecko response");
    }

    const spot: SpotStats = {
      price: requireNumber(market.current_price?.usd, "spot.price"),
      change24hPct: requireNumber(
        market.price_change_percentage_24h,
        "spot.change24hPct"
      ),
      volume24h: requireNumber(market.total_volume?.usd, "spot.volume24h"),
    };

    if (market.high_24h?.usd !== undefined) {
      const high = Number(market.high_24h.usd);
      if (Number.isFinite(high)) {
        spot.high24h = high;
      }
    }
    if (market.low_24h?.usd !== undefined) {
      const low = Number(market.low_24h.usd);
      if (Number.isFinite(low)) {
        spot.low24h = low;
      }
    }

    // Try to fetch market chart data, but gracefully fallback if it fails
    let chartData: any = null;
    try {
      const response = await cg.get("/coins/bitcoin/market_chart", {
        params: {
          vs_currency: "usd",
          days: "2",
          interval: "hourly",
        },
      });
      chartData = response.data;
    } catch (chartError: any) {
      if (axios.isAxiosError(chartError) && chartError.response) {
        console.warn("Market chart error status:", chartError.response.status);
        console.warn("Market chart error data:", chartError.response.data);
      }
      const status = chartError?.response?.status;
      if (status === 401 || status === 403 || status === 429) {
        console.warn(
          "Market chart endpoint requires API key or is rate-limited. Using spot data only for derived indicators."
        );
      } else {
        console.warn(
          `Failed to fetch market chart data: ${chartError?.message || "Unknown error"}. Using spot data only.`
        );
      }
    }

    const pricePoints = Array.isArray(chartData?.prices)
      ? chartData.prices
      : [];
    const volumePoints = Array.isArray(chartData?.total_volumes)
      ? chartData.total_volumes
      : [];

    const closes = pricePoints
      .map((p: unknown) => (Array.isArray(p) ? Number(p[1]) : NaN))
      .filter(Number.isFinite);

    let emaShort: number;
    let emaLong: number;
    let trendDirection: TrendDirection;
    let trendStrengthPct: number;
    let volatility24hPct: number;
    let volumeTrend24hPct: number | null = null;

    if (closes.length >= 10) {
      // We have enough historical data - compute full derived indicators
      const closesWindow = closes.slice(-48);
      const emaShortPeriod = Math.min(10, closesWindow.length);
      const emaLongPeriod = Math.min(50, closesWindow.length);
      emaShort = computeEma(closesWindow, emaShortPeriod);
      emaLong = computeEma(closesWindow, emaLongPeriod);

      if (emaShort > emaLong * 1.002) {
        trendDirection = "UP";
      } else if (emaShort < emaLong * 0.998) {
        trendDirection = "DOWN";
      } else {
        trendDirection = "RANGE";
      }

      if (closes.length > 24) {
        const close24Ago = closes[closes.length - 25];
        const lastClose = closes[closes.length - 1];
        if (close24Ago) {
          trendStrengthPct = ((lastClose - close24Ago) / close24Ago) * 100;
        } else {
          trendStrengthPct = spot.change24hPct;
        }
      } else {
        trendStrengthPct = spot.change24hPct;
      }

      const recentForVol = closes.slice(-24);
      volatility24hPct = computeStdDevPct(
        recentForVol.length > 0 ? recentForVol : closes
      );

      if (volumePoints.length >= 48) {
        const volumes = volumePoints
          .map((v: unknown) => (Array.isArray(v) ? Number(v[1]) : NaN))
          .filter(Number.isFinite);
        if (volumes.length >= 48) {
          const last24 = volumes
            .slice(-24)
            .reduce((a: number, b: number) => a + b, 0);
          const prev24 = volumes
            .slice(-48, -24)
            .reduce((a: number, b: number) => a + b, 0);
          if (prev24 > 0) {
            volumeTrend24hPct = ((last24 - prev24) / prev24) * 100;
          }
        }
      }
    } else {
      // Fallback: compute derived indicators from spot data only
      console.warn(
        "Insufficient historical data. Computing derived indicators from spot data only."
      );
      // Use current price as both EMAs (no history available)
      emaShort = spot.price;
      emaLong = spot.price;

      // Determine trend from 24h change
      if (spot.change24hPct > 0.2) {
        trendDirection = "UP";
      } else if (spot.change24hPct < -0.2) {
        trendDirection = "DOWN";
      } else {
        trendDirection = "RANGE";
      }

      trendStrengthPct = spot.change24hPct;

      // Estimate volatility from high/low range if available
      if (spot.high24h && spot.low24h && spot.price > 0) {
        const rangePct = ((spot.high24h - spot.low24h) / spot.price) * 100;
        // Rough volatility estimate: range / 2 (simplified)
        volatility24hPct = rangePct / 2;
      } else {
        // Default to a conservative estimate
        volatility24hPct = Math.abs(spot.change24hPct) * 0.5;
      }
    }

    const derived: DerivedIndicators = {
      emaShort,
      emaLong,
      trendDirection,
      trendStrengthPct,
      volatility24hPct,
      volumeTrend24hPct,
    };

    console.log("Fetched CoinGecko spot + derived indicators successfully");
    return { spot, derived };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error fetching data";
    throw new Error(`Failed to fetch CoinGecko indicators: ${message}`);
  }
};

