/**
 * Ride24 - przekaznik potwierdzen rezerwacji Arvent (Gmail -> Ride24).
 *
 * Bezpieczenstwo i prywatnosc:
 * - Uprawnienie Gmail TYLKO DO ODCZYTU (gmail.readonly). Skrypt technicznie nie
 *   moze usuwac, archiwizowac, oznaczac jako przeczytane ani zmieniac etykiet.
 * - Czyta wylacznie wiadomosci z etykieta RIDE24_ARVENT (nadawana filtrem Gmaila).
 * - Dla kazdej z nich najpierw pobiera tylko naglowek From. Tresc wysyla
 *   WYLACZNIE gdy nadawca to adres @arventcarrental.com. Inne wiadomosci nie sa
 *   czytane ani wysylane.
 * - Ride24 i tak sprawdza podpis DKIM Arvent, PDF, rezerwacje, API Arvent,
 *   Stripe i termin 24 h. Ten skrypt niczego nie zatwierdza sam.
 */
var LABEL_NAME = 'RIDE24_ARVENT';
var PARTNER_DOMAIN = 'arventcarrental.com';
var ENDPOINT = 'https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/arvent-mail-ingest';
var LOOKBACK_QUERY = 'newer_than:8d has:attachment';
var MAX_PER_RUN = 10;
var MAX_BYTES = 15 * 1024 * 1024;
var KEEP_DONE_MS = 10 * 24 * 3600 * 1000;

/** Uruchom raz: tworzy sekret i wyzwalacz co 1 minute. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('RELAY_SECRET')) {
    props.setProperty('RELAY_SECRET',
      Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }
  labelId_(); // przerywa, jesli etykiety jeszcze nie ma
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'relayArventConfirmations') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('relayArventConfirmations').timeBased().everyMinutes(1).create();
  Logger.log('Wyzwalacz co 1 minute utworzony.');
  Logger.log('Skopiuj do Supabase jako ARVENT_MAIL_RELAY_SECRET:');
  Logger.log(props.getProperty('RELAY_SECRET'));
}

/** Uruchom po dodaniu sekretu w Supabase: sprawdza polaczenie, nic nie wysyla. */
function checkConnection() {
  var secret = PropertiesService.getScriptProperties().getProperty('RELAY_SECRET');
  if (!secret) throw new Error('Najpierw uruchom setup().');
  var r = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-ride24-mail-relay': secret }, payload: JSON.stringify({ ping: true })
  });
  var code = r.getResponseCode();
  if (code === 400) Logger.log('OK: Ride24 przyjmuje sekret. Etykieta: ' + LABEL_NAME + ' (id ' + labelId_() + ').');
  else if (code === 403) Logger.log('BLAD: sekret w Supabase jest inny niz w skrypcie albo jeszcze go nie dodano.');
  else Logger.log('Nieoczekiwana odpowiedz ' + code + ': ' + r.getContentText().slice(0, 200));
}

/** Wyzwalacz co 1 minute. */
function relayArventConfirmations() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty('RELAY_SECRET');
    if (!secret) throw new Error('Brak RELAY_SECRET - uruchom setup().');
    var done = JSON.parse(props.getProperty('DONE') || '{}');
    var now = Date.now();
    Object.keys(done).forEach(function (k) { if (now - done[k] > KEEP_DONE_MS) delete done[k]; });

    var list = Gmail.Users.Messages.list('me', {
      labelIds: [labelId_()], q: LOOKBACK_QUERY, maxResults: 50, includeSpamTrash: false
    });
    var sent = 0;
    (list.messages || []).forEach(function (m) {
      if (sent >= MAX_PER_RUN || done[m.id]) return;
      // Najpierw tylko naglowek From - bez tresci.
      var meta = Gmail.Users.Messages.get('me', m.id, { format: 'metadata', metadataHeaders: ['From'] });
      if (!isPartner_(header_(meta, 'From')) || Number(meta.sizeEstimate || 0) > MAX_BYTES) {
        done[m.id] = now; // nigdy nie czytana ani nie wysylana
        return;
      }
      var full = Gmail.Users.Messages.get('me', m.id, { format: 'raw' });
      var r = UrlFetchApp.fetch(ENDPOINT, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'x-ride24-mail-relay': secret },
        payload: JSON.stringify({ message_id: m.id, raw_base64: toBase64_(full.raw) })
      });
      sent++;
      var body = {};
      try { body = JSON.parse(r.getContentText()); } catch (e) { body = {}; }
      if (r.getResponseCode() === 200 && body.verdict && body.verdict !== 'received') {
        done[m.id] = now; // przetworzona przez Ride24 (zatwierdzona lub odrzucona)
        console.log('Ride24: ' + m.id + ' -> ' + body.verdict + (body.voucher ? ' (voucher)' : ''));
      } else {
        console.warn('Ride24: ponowie ' + m.id + ' (HTTP ' + r.getResponseCode() + ')');
      }
    });
    props.setProperty('DONE', JSON.stringify(done));
  } finally {
    lock.releaseLock();
  }
}

function labelId_() {
  var labels = Gmail.Users.Labels.list('me').labels || [];
  for (var i = 0; i < labels.length; i++) if (labels[i].name === LABEL_NAME) return labels[i].id;
  throw new Error('Brak etykiety ' + LABEL_NAME + ' - utworz filtr Gmaila (krok 1).');
}
function header_(msg, name) {
  var hs = (msg.payload && msg.payload.headers) || [];
  var found = hs.filter(function (h) { return String(h.name).toLowerCase() === name.toLowerCase(); });
  return found.length === 1 ? String(found[0].value) : '';
}
function isPartner_(from) {
  var m = /<([^<>\s]+)>/.exec(from);
  var addr = (m ? m[1] : from).trim().toLowerCase();
  var parts = addr.split('@');
  return parts.length === 2 && parts[0].length > 0 && parts[1] === PARTNER_DOMAIN;
}
function toBase64_(raw) {
  // Usluga zaawansowana zwraca bajty; dla pewnosci obslugujemy tez base64url.
  if (Array.isArray(raw)) return Utilities.base64Encode(raw);
  return String(raw).replace(/-/g, '+').replace(/_/g, '/');
}
