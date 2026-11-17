# Caravel — audyt dokumentu rules.pdf, 17.11.2026

**Zakres**: dokument `rules.pdf` przekazany w rozmowie z Ride24, 1 strona, nagłówek
"TERMS & CONDITIONS — CARAVEL RENT A CAR". To nie jest niezależny odczyt
`GET /v1/reference/terms` ani zawartości drugiego pliku `terms.pdf`.

## Zweryfikowane postanowienia z otrzymanego dokumentu

| Sekcja PDF | Co stanowi regulamin |
| --- | --- |
| 3.1 | Szyby, przednia szyba, inne szkło, koła/opony/felgi, podwozie, lusterka, wnętrze, dach, silnik, zamki i klucze są wyłączone ze wszystkich pakietów. Dodatkowa ochrona WUG na szkło i podwozie jest oferowana w wypożyczalni. |
| 6.1 | Administracyjna opłata **100 EUR za wynajem, w którym doszło do szkody lub kradzieży**, niezależnie od pakietu i również przy zerowym udziale własnym. Jest odrębna od napraw i udziału własnego. |
| 6.3 | Mandaty, opłaty parkingowe, drogowe i podatki obciążają najemcę wraz z opłatą manipulacyjną (bez określenia kwoty w tej sekcji). |
| 4.4 | Dla Premium **nie nalicza się postoju naprawczego za zdarzenia objęte Premium**. Do 20 dni stawki Premium za przestój dotyczy przypadków nieważnej ochrony lub szkody wyłączonej. |
| 5.1–5.3 | Występuje upoważnienie do obciążenia karty przedstawionej przy odbiorze, również po zakończeniu najmu. **Nie ma tu jawnego nakazu karty kredytowej**, ale nie wyjaśniono sytuacji klienta płacącego wyłącznie gotówką i nieokazującego karty. |
| 2.1 / 9.1 | Dopuszczona jest jazda po publicznych drogach utwardzonych; poza nimi ubezpieczenie traci ważność. |
| 2.11 | Wymagany raport policyjny przy wypadku, szkodzie lub kradzieży, pod rygorem utraty ochrony. |
| 6.4 / 6.5 | Zgubione/uszkodzone klucze: 200 EUR plus koszt dostarczenia; pomoc drogowa z winy najemcy płatna. |
| 7.1 | Brak zwrotu przy wcześniejszym zwrocie, spóźnionym odbiorze, no-show lub anulowaniu po rozpoczęciu wynajmu. |

## Dokumenty Ride24 już w bazie

W Supabase `public.partners` istnieje profil Caravel Rent a Car
(`78721481-7619-44df-a9b7-5faa344b69bb`), `api_provider=custom`,
`api_enabled=false`. Kolumny `rental_terms_url` i `rental_rules_url` mają
odnośniki do istniejących plików `terms.pdf` i `rules.pdf` w buckecie
`partner-documents`. Ostatnia aktualizacja obiektów: 11.11.2026.
**Potwierdzono tożsamość przesłanego `rules.pdf` z wersją zapisaną w Storage:**
oba mają 676825 bajtów, lokalne MD5 `3b945c1a96f4473af18795ebe469415c`
zgadza się z ETag obiektu `storage.objects.metadata.eTag` o tej samej wartości.
Lokalne SHA-256: `d2824b9867161d362c8f0d31a51580c22756414bbb10ef078f55947317d8ea2b`.
Nie odczytywano osobno bajtów obiektu z Storage, lecz zgodny ETag MD5
pozwala uznać przesłaną wersję regulaminu za tę samą. Zawartość `terms.pdf`
nie została bezpośrednio zweryfikowana.

Aktualny mechanizm Ride24 w `klient.html` pobiera oba linki, wyświetla
je przed akceptacją i zapisuje w rezerwacji `partner_terms_snapshot`,
`partner_rules_snapshot` oraz `terms_accepted_at` przez
`create-booking-request`. Nie tworzyć drugiego systemu dokumentów.

## Weryfikacja względem e-maila Caravel z 17.11

Caravel w wiadomości potwierdził zero depozytu/udziału własnego w Premium
dla zdarzeń objętych ochroną, brak obowiązkowej **karty kredytowej**, płatność
gotówką lub Visa/MasterCard, wykluczenie L2A, 100 EUR opłaty administracyjnej
i brak ochrony szyb/kół/podwozia. Treść otrzymanego `rules.pdf` potwierdza
opłatę i wyłączenia, **ale numeracja punktów PDF różni się od wiadomości**:
PDF podaje §3.1 zamiast 5.4, §6.1 zamiast 7.1, §6.3 zamiast 7.4.
To może oznaczać inną wersję dokumentu i wymaga sprawdzenia finalnej
obowiązującej wersji przed publikacją. Aktualny `GET /v1/reference/terms`
ma według Caravel pierwszeństwo przed skróconymi kodami ochrony (§2.4
ich dokumentacji API) — jego treści nie zweryfikowano.

## Blokady produkcyjne / czynności techniczne

1. Nie obiecywać ochrony szyb, kół ani podwozia w Premium.
2. Utrzymać obecny rygorystyczny filtr Ride24
   (`REQUIRED_PREMIUM_COVERS`); przy obecnych warunkach Caravel **nie
   publikować żadnych ofert**, nawet przy zerowym depozycie.
3. Filtr `L2A` jest przygotowany w izolacji dla jawnych identyfikatorów grup.
   **Pole przenoszące kod L2A trzeba zweryfikować na odpowiedzi live API**
   przed scaleniem. Nie utożsamiać `L2A` z czteroliterowym ACRISS.
4. Potwierdzić aktualność **obu** przechowywanych PDF i sposób obsługi
   gotówkowego wynajmu w świetle §5.1 (brak obowiązkowej karty kredytowej
   nie musi oznaczać braku konieczności okazania dowolnej karty).
5. Odbiornik HMAC, test rzeczywistej dostawy, certyfikacja i docelowe
   podłączenie do `provider-adapters` są odrębnymi, niezakończonymi pracami.
6. Nie zmieniać danych produkcyjnych Ride24, AVIA, Stripe ani APK w trakcie
   tych przygotowań; `api_enabled=false`, PR #84 draft.

**Wniosek**: wykonany audyt wyłącznie na podstawie przekazanego PDF,
danych profilu Supabase i treści e-maila Caravel. Nie stanowi aprobaty
prawnej ani potwierdzenia warunków aktualnego endpointu terms API.
