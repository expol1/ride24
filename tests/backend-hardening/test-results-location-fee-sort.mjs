import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const html = read('results.html');
const source = read('assets/js/results-location-pricing.js');
const browser = { window: {} };
runInNewContext(source, browser);
const pricing = browser.window.Ride24ResultPricing;

function localCar(id, pickupFee, returnFee, extras = {}) {
    return {
        id, driver_included: false,
        partners: {
            id,
            currency: 'EUR',
            partner_locations: [{
                location_name: 'Airport', extra_fee: pickupFee > 0,
                extra_fee_amount: pickupFee
            }]
        },
        ...extras,
        localReturn: new Map([[id, [{ return_fee_amount: returnFee }]]])
    };
}
function customerFees(car, marginPercent = 0) {
    const fees = pricing.selectedLocationFees(car, 'Airport', 'Hotel', car.localReturn);
    return pricing.customerLocationFeeTotal(fees, marginPercent);
}

test('ranking includes delivery and collection once each, so 50 precedes 30 + 50', () => {
    const a = localCar('A', 0, 0);
    const b = localCar('B', 50, 0);
    const c = localCar('C', 0, 10);
    const rank = new Map([
        [a, pricing.totalRankPrice(50, customerFees(a), 1)],
        [b, pricing.totalRankPrice(30, customerFees(b), 1)],
        [c, pricing.totalRankPrice(60, customerFees(c), 1)],
    ]);
    assert.deepEqual([b, c, a].sort((x, y) => pricing.compareByTotalPrice(x, y, rank)).map(x => x.id),
        ['A', 'C', 'B']);
    assert.equal(rank.get(b), 80);
});

test('pickup and return use independent charges even when the location is the same', () => {
    const car = localCar('same', 12, 25);
    const fees = pricing.selectedLocationFees(car, 'Airport', 'Airport', car.localReturn);
    assert.equal(fees.pickup, 12);
    assert.equal(fees.return, 25);
    assert.equal(pricing.customerLocationFeeTotal(fees, 25), 46.25);
});

test('a different return location is not charged the pickup fee by mistake', () => {
    const car = {
        id: 'API', api_managed: true, api_quote_id: 'example',
        partners: { id: 'API', partner_locations: [
            { location_name: 'Airport', extra_fee: true, extra_fee_amount: 20, return_fee_amount: 999 },
            { location_name: 'City', extra_fee: true, extra_fee_amount: 999, return_fee_amount: 15 }
        ] }
    };
    const fees = pricing.selectedLocationFees(car, 'Airport', 'City', new Map());
    assert.equal(fees.pickup, 20);
    assert.equal(fees.return, 15);
});

test('fees have the same per-line cent rounding and margin as the booking engine', () => {
    assert.equal(pricing.customerLocationFeeTotal({ pickup: 9.99, return: 10.01 }, 25), 25);
    assert.equal(pricing.customerLocationFeeTotal({ pickup: 50, return: 0 }, 25), 62.5);
    assert.equal(pricing.customerLocationFeeTotal({ pickup: 0, return: 0 }, 25), 0);
});

test('VIP is only a tie-breaker and currency conversion compares full totals', () => {
    const regular = { driver_included: false }, vip = { driver_included: true };
    let ranks = new Map([[regular, 50], [vip, 80]]);
    assert.deepEqual([vip, regular].sort((a, b) => pricing.compareByTotalPrice(a, b, ranks)), [regular, vip]);
    ranks = new Map([[regular, 80], [vip, 80]]);
    assert.deepEqual([regular, vip].sort((a, b) => pricing.compareByTotalPrice(a, b, ranks)), [vip, regular]);
    assert.equal(pricing.totalRankPrice(50, 10, 4), 240);
    assert.equal(pricing.totalRankPrice(50, 10, NaN), Infinity);
});

test('search actually reads selected return fee and uses new helpers before slicing to 20 cars', () => {
    assert.match(html, /results-location-pricing\.js\?v=/);
    assert.match(html, /\.select\('partner_id,return_fee_amount'\)/);
    assert.match(html, /resultPricing\.selectedLocationFees\(/);
    assert.match(html, /getSeasonPrice\(car\) \* days, locationFeesByCar\.get\(car\), rate/);
    assert.match(html, /cars\.sort\(\(a, b\) => resultPricing\.compareByTotalPrice\(a, b, rankingPrices\)\)/);
    assert.ok(html.indexOf('cars.sort((a, b) => resultPricing.compareByTotalPrice') < html.indexOf('cars = cars.slice(0, PAGE_SIZE)'));
});
