# Pobranie kopii Ride24 z 8 października 2026

Kopia jest prywatna i zaszyfrowana. Link do dużego lokalnego ZIP w rozmowie nie został skutecznie udostępniony przez ChatGPT. Nie opublikowano danych ani klucza w GitHubie.

1. W panelu Supabase otwórz projekt Ride24, identyfikator `zwyerdeuvyzgkgwglowr`.
2. W Storage otwórz prywatny bucket `ride24-recovery`, następnie folder `20261008-before-hardening`.
3. Pobierz wszystkie pięć plików `backup.aesgcm.part01`–`backup.aesgcm.part05` i `manifest.json` do jednego folderu na komputerze. Zachowaj dokładne nazwy plików.
4. W Vault odczytaj wartość sekretu `ride24_recovery_backup_key_20261008`. Zachowaj ją lokalnie w pliku tekstowym `key-base64.txt`. Nie wysyłaj jej w czacie ani nie dodawaj do repozytorium. Klucz przechowuj osobno od kopii.
5. Pobierz znajdujący się obok skrypt `restore-backup.mjs`. Korzystając z Node.js 22 lub nowszego, uruchom go lokalnie, wskazując folder kopii i plik klucza:

```text
node restore-backup.mjs "C:\Ride24-backup" "C:\Ride24-key\key-base64.txt"
```

Skrypt działa bez internetu. Sprawdza sumy kontrolne wszystkich części, poprawność szyfrowania i sumę kontrolną odtworzonego ZIP, następnie tworzy `Ride24_Backup_Restored.zip`. Nie nadpisuje istniejących plików i nie zmienia Supabase. Plik ZIP zawiera dane poufne.

Przywracanie produkcji opisano w `2026-10-08-backend-hardening.md`. Samo pobranie lub odszyfrowanie niczego nie przywraca. Ta kopia pozwala wycofać wykonane poprawki w tym samym projekcie; nie jest pełną kopią PITR ani pełnym eksportem aktywnych sesji Auth i wartości zmiennych środowiskowych Edge Functions. Kod strony zachowano również na gałęzi `backup/before-backend-hardening-20261008`.
