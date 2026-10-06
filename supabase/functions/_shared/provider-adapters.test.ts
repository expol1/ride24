import {
  normalizeEasyWebRentAvailability,
  normalizeEasyWebRentGroups,
  normalizeEasyWebRentLocations,
  normalizeRenteonAvailability,
  normalizeRenteonGroups,
  normalizeRenteonLocations,
} from "./provider-adapters.ts";
import type { PartnerApiCredentials } from "./partner-api.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

const credentials: PartnerApiCredentials = {
  partner_id: "00000000-0000-0000-0000-000000000001",
  api_url: "https://provider.example/en",
  auth_type: "custom_headers",
  endpoints: {},
  extra_headers: {},
  timeout_ms: 10_000,
};

Deno.test("Renteon locations map Bosnia and airport metadata", () => {
  const locations = normalizeRenteonLocations(credentials, [{
    Id: 101,
    Name: "Mostar Airport",
    Town: "Mostar",
    CountryCode: "BA",
  }]);

  assert(locations.length === 1, "one Renteon location expected");
  assertEquals(locations[0].external_id, "101", "external ID");
  assertEquals(locations[0].country, "Bosnia and Herzegovina", "country mapping");
  assertEquals(locations[0].city, "Mostar", "city mapping");
  assertEquals(locations[0].type, "airport", "airport mapping");
});

Deno.test("Renteon categories synchronize without inventing a static live price", () => {
  const groups = normalizeRenteonGroups(credentials, [{
    Id: 501,
    SIPP: "CDMR",
    ModelName: "Volkswagen Golf",
    PassengerCapacity: 5,
    BigBagsCapacity: 2,
    SmallBagsCapacity: 1,
    ShowInList: true,
  }]);

  assert(groups.length === 1, "one Renteon group expected");
  assertEquals(groups[0].external_id, "501", "group external ID");
  assertEquals(groups[0].class_code, "C", "Ride24 class fallback");
  assertEquals(groups[0].public_price, 0, "metadata sync price");
  assertEquals(groups[0].bags, 3, "bag capacity");
});

Deno.test("Renteon availability preserves period total and creates Ride24 per-day equivalent", () => {
  const groups = normalizeRenteonAvailability(
    credentials,
    [{
      OfficeOutId: 101,
      AvailabilityCarCategories: [{
        CarCategoryId: 501,
        Amount: 100,
        Currency: "EUR",
        PriceDate: "2026-10-06T10:00:00",
        PricelistId: 77,
        SIPP: "CDMR",
        ModelName: "Volkswagen Golf",
        PassengerCapacity: 5,
        AvailableCount: 1,
      }],
    }],
    {
      pickup_location_id: "101",
      dropoff_location_id: "101",
      pickup_date: "2026-11-01",
      return_date: "2026-11-03",
      pickup_time: "10:00",
      return_time: "10:00",
      currency: "EUR",
    },
  );

  assert(groups.length === 1, "one availability group expected");
  assertEquals(groups[0].public_price_total, 100, "provider total");
  assertEquals(groups[0].public_price, 50, "two-day internal daily equivalent");
  assertEquals(groups[0].currency, "EUR", "currency");
  const quote = groups[0].provider_quote_data as Record<string, unknown>;
  assertEquals(quote.pricelist_id, 77, "Renteon pricelist mapping");
  assert(
    typeof quote.availability_car_category === "object",
    "Renteon availability category must be retained server-side for booking Create",
  );
});

Deno.test("Easy Web Rent generic locations and groups normalize into Ride24 metadata", () => {
  const locations = normalizeEasyWebRentLocations({
    data: [{
      id: "MST",
      name: "Mostar",
      city: "Mostar",
      country_code: "BA",
      active: true,
    }],
  });
  const groups = normalizeEasyWebRentGroups(credentials, {
    data: [{
      id: "ECONOMY",
      acriss_code: "EDMR",
      example_model: "Skoda Fabia",
      seats: 5,
      bags: 2,
      active: true,
    }],
  });

  assertEquals(locations[0].country, "Bosnia and Herzegovina", "EWR country");
  assertEquals(groups[0].external_id, "ECONOMY", "EWR group");
  assertEquals(groups[0].class_code, "E", "EWR class");
});

Deno.test("Easy Web Rent one-way quote keeps pickup and return IDs and period total", () => {
  const groups = normalizeEasyWebRentAvailability(
    credentials,
    {
      data: [{
        vehicle_class_id: "ECONOMY",
        total_price: 120,
        currency: "EUR",
        available: true,
        quote_id: "Q-123",
      }],
    },
    {
      pickup_location_id: "MST",
      dropoff_location_id: "SJJ",
      pickup_date: "2026-11-01",
      return_date: "2026-11-04",
      pickup_time: "10:00",
      return_time: "10:00",
      currency: "EUR",
    },
  );

  assert(groups.length === 1, "one EWR availability group expected");
  assertEquals(groups[0].public_price_total, 120, "EWR provider total");
  assertEquals(groups[0].public_price, 40, "three-day internal daily equivalent");
  assertEquals(
    groups[0].location_external_ids,
    ["MST", "SJJ"],
    "one-way location mapping",
  );
  assertEquals(groups[0].quote_reference, "Q-123", "quote reference");
});
