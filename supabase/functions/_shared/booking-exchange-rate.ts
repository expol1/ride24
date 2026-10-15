function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return value.length > 0 && isRecord(value[0]) ? value[0] : null;
  }
  return isRecord(value) ? value : null;
}

export async function exchangeRate(currency: string): Promise<number> {
  if (currency === "PLN") return 1;

  const tables = ["A", "B"] as const;
  for (const table of tables) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6_000);

    try {
      const response = await fetch(
        `https://api.nbp.pl/api/exchangerates/rates/${table}/${currency}/?format=json`,
        {
          headers: { Accept: "application/json" },
          signal: controller.signal,
          redirect: "error",
        },
      );

      if (response.status === 404) continue;
      if (!response.ok) throw new Error("NBP_HTTP_ERROR");

      const contentLength = Number(response.headers.get("content-length") || "0");
      if (Number.isFinite(contentLength) && contentLength > 64_000) {
        throw new Error("NBP_RESPONSE_TOO_LARGE");
      }

      const payload = await response.json();
      const payloadRecord = firstRecord(payload);
      const rates = Array.isArray(payloadRecord?.rates) ? payloadRecord.rates : [];
      const rate = Number(firstRecord(rates)?.mid);

      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error("NBP_INVALID_RATE");
      }
      return rate;
    } catch (error) {
      if (table === "B") {
        console.warn("create-booking-request NBP unavailable", currency);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  // Zachowujemy dotychczasowy awaryjny fallback wyłącznie dla EUR/USD.
  if (currency === "USD") return 4.0;
  if (currency === "EUR") return 4.5;
  throw new Error("Nie udało się pobrać kursu waluty partnera");
}

