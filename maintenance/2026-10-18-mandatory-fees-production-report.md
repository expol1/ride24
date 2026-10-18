# Ride24 — obowiązkowe opłaty: raport wdrożenia (18 października 2026)

## Zmiany wykonane
- Połączono PR #36 z `main`: https://github.com/expol1/ride24/pull/36
- Zapisano gałąź `backup/before-mandatory-fees-20261018`.
- W produkcyjnym projekcie Supabase Ride24 (`zwyerdeuvyzgkgwglowr`) uruchomiono dwie addytywne migracje.
- Opublikowano `booking-options` w wersji 2 i `create-booking-request` w wersji 18. Zweryfikowano byte-for-byte zgodność wszystkich plików obu funkcji z aktualnym `main`.
- Jednorazowo wykonano w transakcji `maintenance/2026-10-18-all-partners-fee-cutover.sql`.
- Po wykonaniu transakcji: **6 aktywnych reguł czasu, 2 obowiązkowe reguły lokalizacji/trasy, 2 blokady godzin i 9 wpisów audytu**. Wszystkie 9 przenoszonych produktów `partner_extras` są nieaktywne; oryginalne rekordy nadal istnieją. `priced_extras_enabled=true`.
- Opłaty lokalizacyjne partnera NOVAKOVIC z Czarnogóry nie zostały zmienione.
- Serwery API partnerów są nadal autorytatywne dla ich własnych wycen; nowy mechanizm nie stosuje się do firm z `provider_type=api`.

## Reguły aktywne — kwoty bazowe partnerów
| Partner | Reguła | Kwota |
|---|---|---:|
| Mountain Calendar / Madlobos | Odbiór 22:00–07:00, jedna opłata za rezerwację | 50 EUR |
| Mountain Calendar | Transfer do/z Madeira Airport (FNC), raz na rezerwację | 15 EUR |
| Mountain Calendar | Zwrot w innym mieście, jeśli oba miasta to różne elementy zbioru Lisbon, Porto, Faro | 120 EUR |
| Auto Ilhéu | Odbiór PDL 19:45–23:45 | 15 EUR |
| Auto Ilhéu | Zwrot PDL 05:00–07:00 | 25 EUR |
| Auto Ilhéu | PDL — odbiór 23:45–07:00 | niedostępny |
| Auto Ilhéu | PDL — zwrot 23:45–05:00 | niedostępny |
| Cosmo Rent | Odbiór 00:01–08:00 | 50 EUR |
| Laima's | Odbiór lub zwrot 20:00–06:00, raz za rezerwację | 25 EUR |
| STAR | Odbiór/zwrot 19:40–08:30, 20 EUR za każde wystąpienie; wymagane potwierdzenie | 20 EUR |

Kwoty to kwoty bazowe dla partnera; cena klienta pozostaje ustalana na serwerze według aktualnych reguł marży i rabatów Ride24, tak jak przy opłatach lokalizacyjnych.

## Pozostałe dobrowolne `custom`
- Mountain Calendar: Wi-Fi 5 EUR/dzień — słusznie pozostaje w dodatkach.
- Sleid Rental: pozwolenie na przekroczenie granicy (Czarnogóra/Macedonia Północna) 100 EUR — nie można ustalić zamiaru podróży na podstawie lokalizacji odbioru/zwrotu; świadomie pozostawiono wybór klientowi.
- Profil **tets**: testowy wpis `custom` o nieodpowiedniej nazwie został wyłączony z katalogu. Sam profil pozostawiono aktywny (5 historycznych rezerwacji); brak usuwania danych testowych bez osobnej decyzji właściciela.

## Kontrole
- GitHub Actions `Ride24 Mandatory Fee QA`: testy kalkulatora, cen, zmian godzin, Azorów, transferu FNC, tras kontynentalnych, obowiązkowego potwierdzenia, formularzy WEB, bezpieczeństwa prezentacji oraz awaryjnego wyłączenia płatnych dodatków — **PASS**.
- Zabezpieczenia tabel: RLS i 4 polityki właścicielskie na każdej tabeli edytowalnych reguł; tabela audytu tylko dla roli administracyjnej.
- Zweryfikowano oddzielnie w DB: 6 reguł czasu, 2 blokady Azorów, 2 warunki tras/lokalizacji, 9 wyłączonych produktów źródłowych i brak zmian opłat Czarnogóry.
- Nie wykonano nowej płatności Stripe ani rzeczywistej rezerwacji klienta w celach testowych.
- Nie potwierdzono ręcznie aktualnej publikacji stron na `ride24.pl` ani instalacji na fizycznych urządzeniach Android; repozytorium i serwerowa część produkcyjna są wdrożone. Należy weryfikować te dwa punkty przed uznaniem pełnego E2E.
- Dane otwarcia standardowego biura Auto Ilhéu nie są jednoznacznie potwierdzone. Nie wprowadzano reguł biura/miasta bez uzgodnienia, a tylko precyzyjny zakaz w punkcie PDL poza dozwolonymi oknami.

## Bezpieczne cofnięcie
Nie przywracaj całej bazy: istniejące `bookings.pricing_items_snapshot` muszą pozostać historyczne. Wyłącz konkretne nowe reguły, potem w jednej transakcji przywróć `active=true` dla źródłowych `partner_extras` zapisanych w `partner_fee_migration_audit`, a w razie potrzeby przywróć kod z `backup/before-mandatory-fees-20261018` oraz wcześniej zweryfikowanych wersji Edge Functions.
