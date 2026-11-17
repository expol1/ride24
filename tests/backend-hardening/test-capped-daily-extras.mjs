import test from 'node:test';
import assert from 'node:assert/strict';
import { cappedCatalogForQuote, makeBookingQuote } from '../../supabase/functions/_shared/booking-options.mjs';

const greenCard = {
  id: 'green-card-test', code: 'custom',
  name_en: 'Green Card – cross-border permit (€10/day, max €100)',
  name_pl: 'Zielona Karta – wyjazd za granicę (10 €/dzień, maks. 100 €)',
  amount: '10.00', billing: 'day', max_quantity: 1,
  max_total_amount: '100.00', active: true,
};
const options = {
  pickup: { id: 'p', name: 'Mostar Airport (OMO)', city: 'Mostar', amount: 0 },
  dropoff: { id: 'd', name: 'Mostar City', city: 'Mostar', amount: 0 },
  catalog: [greenCard],
  timeRules: [], timeBlocks: [], conditionalFees: [],
};
const base = {
  options,
  selections: [{ id: greenCard.id, quantity: 1 }],
  hasAdditionalDriver: false,
  context: { userId: 'test-user', carId: 'test-car', pickupTime: '10:00', returnTime: '10:00' },
  rental: { base_total: 200, final_total: 220 },
  marginPercent: 10,
  loyaltyPercent: 0,
  currency: 'EUR',
  exchangeRate: 4,
};

test('Green Card daily price capped at partner EUR 100, Ride24 keeps 10% margin', async () => {
  for (const days of [1,2,3,5,10,15,20,30]) {
    const { snapshot, publicQuote } = await makeBookingQuote({...base,days});
    const item = snapshot.items.find(x => x.kind === 'extra');
    const partnerCents = Math.min(days * 1000, 10000);
    const customerCents = Math.round(partnerCents * 1.10);
    assert.equal(item.partner_cents,partnerCents,'partner for '+days+' days');
    assert.equal(item.customer_cents,customerCents,'customer for '+days+' days');
    assert.equal(item.billing,'rental');
    assert.equal(item.days,1);
    assert.equal(publicQuote.catalog[0].unit_customer_cents,customerCents);
    assert.equal(publicQuote.catalog[0].billing,'rental');
    assert.equal(publicQuote.pricing.pickup_payment_cents,20000+partnerCents);
    assert.equal(snapshot.online_pln_cents,Math.round((2000+customerCents-partnerCents)*4));
  }
});

test('no Green Card selection leaves rental unchanged',async()=>{
  const {snapshot}=await makeBookingQuote({...base,days:15,selections:[]});
  assert.equal(snapshot.items.length,1);
  assert.equal(snapshot.partner_cents,20000);
  assert.equal(snapshot.gross_cents,22000);
});

test('all other daily extras remain uncapped',async()=>{
  const regularExtra={...greenCard,id:'regular-daily',max_total_amount:null};
  const {snapshot,publicQuote}=await makeBookingQuote({
    ...base,days:15,
    options:{...options,catalog:[regularExtra]},
    selections:[{id:regularExtra.id,quantity:1}],
  });
  assert.equal(snapshot.items[1].partner_cents,15000);
  assert.equal(snapshot.items[1].customer_cents,16500);
  assert.equal(snapshot.items[1].billing,'day');
  assert.equal(publicQuote.catalog[0].billing,'day');
});

test('capped extra cannot have multiple quantities or the wrong billing setup',()=>{
  assert.throws(()=>cappedCatalogForQuote([{...greenCard,max_quantity:2}],15),/INVALID_CAPPED_EXTRA/);
  assert.throws(()=>cappedCatalogForQuote([{...greenCard,billing:'rental'}],15),/INVALID_CAPPED_EXTRA/);
  assert.throws(()=>cappedCatalogForQuote([{...greenCard,max_total_amount:0}],15),/INVALID_CAPPED_EXTRA/);
  assert.throws(()=>cappedCatalogForQuote([greenCard],0),/INVALID_CAPPED_EXTRA_DURATION/);
  assert.throws(()=>cappedCatalogForQuote([greenCard],367),/INVALID_CAPPED_EXTRA_DURATION/);
});
