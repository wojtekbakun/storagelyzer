# Storagelyzer w Mac App Store

[English](README.md) · **Polski**

Wszystko, czego potrzeba, żeby Storagelyzer trafił do Mac App Store jako darmowa aplikacja. Część „Teraz” da się zrobić bez konta deweloperskiego, a część „Po wykupieniu konta” to lista kroków na dzień, w którym konto będzie aktywne.

## Co jest przygotowane

| Co | Gdzie |
|---|---|
| Aplikacja działa w App Sandbox (wymóg Mac App Store) | `src-tauri/src/sandbox.rs` i zmiany w `macos.rs`, `volumes.rs`, `cleanup.rs` |
| Uprawnienia (entitlements) do sklepu i do testów lokalnych | `src-tauri/macos/AppStore.entitlements`, `Sandbox-local.entitlements` |
| Manifest prywatności (wymagany przez Apple) | `src-tauri/macos/PrivacyInfo.xcprivacy` |
| Polskie i angielskie teksty zgód systemowych; dzięki nim sklep pokaże oba języki | `src-tauri/macos/{en,pl}.lproj/InfoPlist.strings` |
| Brak szyfrowania, więc bez pytań o eksport | `ITSAppUsesNonExemptEncryption = false` w `src-tauri/Info.plist` |
| Wersja 1.0.0 | `tauri.conf.json`, `Cargo.toml`, `package.json` |
| Budowanie, podpisywanie, paczka `.pkg`, wysyłka | `scripts/appstore.sh` (`npm run appstore -- …`) |
| Zrzuty ekranu 2880 × 1800, po angielsku (polska wersja sklepu też je pokazuje) | `appstore/screenshots/en-US/` (generuje `npm run media -- appstore`) |
| Nazwa, podtytuł, opis, słowa kluczowe, linki (EN, PL) | `appstore/metadata/` (układ zgodny z `fastlane deliver`) |
| Notatki dla recenzenta Apple | `appstore/metadata/review_information/notes.txt` |
| Polityka prywatności i strona pomocy | `docs/privacy.html`, `docs/support.html` (storagelyzer.wojciechbakun.pl) |

### Czym wersja z App Store różni się od wersji budowanej ze źródeł

App Sandbox nie pozwala czytać dysku bez zgody użytkownika, uruchamiać innych programów z jego uprawnieniami ani prosić o hasło administratora. Dlatego:

- **Dostęp do dysków.** Przy pierwszym kliknięciu dysku albo folderu macOS pokazuje okno „Zezwól na dostęp”. Zgoda jest zapamiętywana (security-scoped bookmark w kontenerze aplikacji), więc pytanie pada raz. Ekran startowy od razu proponuje zgodę na „Macintosh HD”.
- **Pełny dostęp do dysku** działa tak jak wcześniej, ale dopiero po udzieleniu zgody na dysk (bez niej nie da się go wykryć).
- **Nie ma** czyszczenia Homebrew, usuwania niedostępnych symulatorów (sam rozmiar symulatorów nadal jest mierzony) ani usuwania migawek Time Machine, bo te akcje uruchamiają `brew`, `xcrun` albo `tmutil` z hasłem administratora.
- **Nie ma Szybkiego podglądu**, bo `qlmanage` nie startuje z sandboxu (sprawdzone). W wersji z App Store Enter i dwuklik na pliku otwierają go zamiast podglądu.
- Finder, Ustawienia systemowe i schowek działają przez AppKit, a nie przez `open` czy `pbcopy`, w obu wersjach.

Wersja budowana ze źródeł (`npm run install-app`) działa dokładnie jak dotąd: o tym, w jakim trybie działa aplikacja, decyduje system (zmienna `APP_SANDBOX_CONTAINER_ID`), a nie osobna gałąź kodu.

## Teraz, bez konta deweloperskiego

### 1. Przetestuj wersję z App Store na swoim Macu

```bash
npm run appstore -- local
```

Buduje aplikację z tym samym sandboxem co w sklepie (podpis ad hoc) w `src-tauri/target/appstore/local/Storagelyzer.app` i ją otwiera. Nie zastępuje `/Applications/Storagelyzer.app`. Jej dane i zapamiętane zgody leżą w `~/Library/Containers/com.wojtek.storagelyzer`; żeby zacząć od zera, zamknij aplikację i usuń ten folder.

Co sprawdzić (tego nie da się przeklikać automatycznie, bo to systemowe okna):

- [ ] Baner „Zezwól na odczyt dysku” → „Zezwól na dostęp…” → w oknie od razu „Zezwól na dostęp”. Baner znika, a przy Macintosh HD nie ma już etykiety „wymaga zgody”.
- [ ] Skan Macintosh HD daje podobny wynik jak wersja z `/Applications`.
- [ ] Zamknij i otwórz ponownie: aplikacja nie pyta drugi raz.
- [ ] „Wybierz folder…” i przeciągnięcie folderu na okno skanują ten folder.
- [ ] „Zwolnij miejsce” pokazuje kategorie (bez Homebrew i migawek Time Machine).
- [ ] „Przenieś do Kosza” na czymś nieważnym (np. pliku z `~/Library/Logs`), a potem przywrócenie go z Kosza.
- [ ] Prawy przycisk na wierszu → „Pokaż w Finderze”, „Otwórz”, „Kopiuj ścieżkę”.
- [ ] Pełny dostęp do dysku: Ustawienia systemowe → Prywatność i ochrona → Pełny dostęp do dysku → **+** → `src-tauri/target/appstore/local/Storagelyzer.app`, potem ponowne uruchomienie. Baner o pełnym dostępie znika, a „bez dostępu” w pasku stanu maleje.
- [ ] Dysk zewnętrzny (jeśli jest): pyta o zgodę osobno.

Tryb sandbox interfejsu można też obejrzeć w przeglądarce: `npm run dev`, potem `http://localhost:1420/?sandboxed`.

### 2. Opublikuj stronę prywatności i pomocy

App Store Connect wymaga adresu polityki prywatności i strony wsparcia. Teksty sklepu wskazują na:

- https://storagelyzer.wojciechbakun.pl/privacy
- https://storagelyzer.wojciechbakun.pl/support

(polska wersja sklepu z dopiskiem `?lang=pl`, zob. `metadata/pl/*_url.txt`). Bez dopisku strony są po angielsku, a przełącznik EN/PL jest w prawym górnym rogu.

Strona na tej subdomenie to Worker na Cloudflare ze statycznymi plikami z `docs/`. Wdraża ją skrypt `wdrozenia/aplikacje.sh storagelyzer`, który bierze `docs/` z commita aktualnie wybranego w repozytorium (więc najpierw scal tę gałąź do `main` i ją wybierz) i dokleja Cloudflare Web Analytics. Ta sama zawartość trafia też na GitHub Pages (wojtekbakun.github.io/storagelyzer) po scaleniu do `main`. Kontakt na stronie pomocy prowadzi do GitHub Issues; jeśli wolisz e-mail, dopisz go w `docs/support.html`.

## Po wykupieniu konta

### 3. Apple Developer Program

[developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/) → konto **Individual** (osoba prywatna) na Twoje Apple ID z włączonym dwuetapowym uwierzytelnianiem. Kosztuje 99 USD rocznie. W sklepie jako sprzedawca widnieje imię i nazwisko z konta. Aktywacja trwa zwykle od kilku godzin do 2 dni.

Dla darmowej aplikacji **nie trzeba** podpisywać umowy „Paid Apps” ani podawać danych podatkowych i bankowych. Umowa dla darmowych aplikacji jest częścią umowy programu.

### 4. Certyfikaty

Xcode → Settings → Accounts → Twoje Apple ID → Manage Certificates… → **+**:

- **Apple Distribution** – podpis aplikacji,
- **Mac Installer Distribution** – podpis paczki `.pkg` (w Pęku kluczy widnieje jako „3rd Party Mac Developer Installer: …”).

Pełne nazwy wypisze `security find-identity -v`.

### 5. Identyfikator aplikacji i profil

[developer.apple.com/account/resources](https://developer.apple.com/account/resources/identifiers/list):

1. **Identifiers → +** → App IDs → App → opis „Storagelyzer”, Bundle ID **Explicit**: `com.wojtek.storagelyzer`, platforma macOS. Bez dodatkowych capabilities (sandbox to entitlement, nie capability w portalu).
2. **Profiles → +** → Distribution → **Mac App Store Connect** → wybierz App ID `com.wojtek.storagelyzer` → certyfikat Apple Distribution → pobierz plik `.provisionprofile`.

Bundle ID po pierwszym wysłaniu jest na zawsze. Jeśli wolisz inny (np. `com.wojtekbakun.storagelyzer`), zmień go teraz w `tauri.conf.json`, `scripts/appstore.sh` i `src-tauri/macos/AppStore.entitlements`.

### 6. Ustawienia skryptu

```bash
cp scripts/appstore.env.example scripts/appstore.env
```

Uzupełnij Team ID, nazwy obu certyfikatów i ścieżkę do profilu. Plik jest w `.gitignore`. Potem:

```bash
npm run appstore -- check
```

Wszystko powinno mieć ✓ (klucz API jest opcjonalny).

### 7. Aplikacja w App Store Connect

[appstoreconnect.apple.com](https://appstoreconnect.apple.com) → Apps → **+** → New App:

| Pole | Wartość |
|---|---|
| Platforms | macOS |
| Name | `Storagelyzer: Disk Analyzer` (jeśli nazwa jest zajęta, spróbuj np. `Storagelyzer – Disk Usage`) |
| Primary Language | English (U.S.) |
| Bundle ID | com.wojtek.storagelyzer |
| SKU | `storagelyzer` |
| User Access | Full Access |

### 8. Build i wysyłka

```bash
npm run appstore -- build
```

Buduje wersję uniwersalną (Apple Silicon + Intel), podpisuje ją z profilem i tworzy `dist-appstore/Storagelyzer-1.0.0-<build>.pkg`. Numer buildu (`CFBundleVersion`) to data i godzina, więc każdy build ma nowy numer, a wersja zostaje 1.0.0.

Wysyłka, do wyboru:

- **Transporter** (darmowa aplikacja Apple z Mac App Store): zaloguj się, przeciągnij `.pkg`, „Deliver”;
- albo `npm run appstore -- upload` z kluczem API (App Store Connect → Users and Access → Integrations → App Store Connect API → klucz z rolą Developer; plik `AuthKey_<ID>.p8` do `~/.appstoreconnect/private_keys/`, a `ASC_KEY_ID` i `ASC_ISSUER_ID` do `appstore.env`).

Po 5–30 minutach build pojawi się w zakładce TestFlight. **Polecam najpierw TestFlight**: dodaj siebie jako testera wewnętrznego, zainstaluj aplikację przez TestFlight na Macu i przejdź listę z kroku 1 na prawdziwie podpisanej wersji.

### 9. Strona w sklepie

W App Store Connect → Storagelyzer → wersja 1.0 (dodaj też lokalizację **Polish**, przełącznik języka u góry po prawej):

| Pole w App Store Connect | Plik |
|---|---|
| Name | `metadata/<język>/name.txt` |
| Subtitle | `metadata/<język>/subtitle.txt` |
| Promotional Text | `metadata/<język>/promotional_text.txt` |
| Description | `metadata/<język>/description.txt` |
| Keywords | `metadata/<język>/keywords.txt` |
| Support URL | `metadata/<język>/support_url.txt` |
| Marketing URL | `metadata/<język>/marketing_url.txt` |
| Privacy Policy URL (App Information / App Privacy) | `metadata/<język>/privacy_url.txt` |
| Screenshots (Mac) | `screenshots/en-US/*.png` w kolejności nazw, tylko w lokalizacji angielskiej; polska pokazuje te same |
| Copyright | `metadata/copyright.txt` |
| Category | Primary: Utilities, Secondary: Developer Tools (opcjonalnie) |

Pozostałe sekcje:

- **App Privacy** → Get Started → „No, we do not collect data from this app” → Publish. Etykieta w sklepie: „Data Not Collected”.
- **Age Rating**: wszędzie „None” / „No” (brak treści dla dorosłych, brak treści od użytkowników, brak czatu, brak nieograniczonego dostępu do sieci, brak reklam). Wynik: 4+.
- **Pricing and Availability**: Price → **Free (0)**. Availability → wszystkie kraje. Wyjątkiem są Chiny kontynentalne, które wymagają numeru rejestracji ICP, więc najprościej je odznaczyć.
- **App Information → Content Rights**: „No, it does not contain, show, or access third-party content”.
- **Digital Services Act** (Business → Compliance): status przedsiębiorcy w UE. Przy hobbystycznej darmowej aplikacji zwykle wybiera się „not a trader”. Jako „trader” musiałbyś opublikować adres i telefon. To Twoja decyzja prawna; bez odpowiedzi aplikacja nie pojawi się w krajach UE.
- **Encryption**: pytań nie będzie, bo załatwia to `ITSAppUsesNonExemptEncryption = false`.
- **App Review Information**: imię, nazwisko, telefon, e-mail (widzi je tylko Apple), „Sign-in required” odznaczone, Notes z `metadata/review_information/notes.txt`.
- **Version Release**: „Manually release this version”, żeby wydać 1.0 samemu po akceptacji.

### 10. Wysłanie do recenzji

W wersji 1.0 wybierz build z TestFlight → Add for Review → Submit. Recenzja trwa zwykle 1–2 dni. Najczęstsze pytania recenzentów przy takiej aplikacji, na które odpowiadają już notatki:

- *Po co `network.client`?* WKWebView bez niego nie uruchamia procesów pomocniczych w sandboxie (sprawdzone: bez niego interfejs się nie ładuje). Aplikacja nie łączy się z siecią.
- *Po co Full Disk Access?* Jest opcjonalny, a aplikacja działa bez niego i mówi, czego nie mogła odczytać.
- *Czy usuwa dane innych aplikacji?* Tylko to, co wskaże użytkownik, zawsze do Kosza. Dane zainstalowanych aplikacji są tylko do wglądu.

## Kolejne wersje

1. Podnieś wersję w `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` i `package.json` (np. 1.0.1).
2. `npm run appstore -- build`, potem upload.
3. W App Store Connect: „+ Version”, tekst „What's New”, wybór buildu, Submit.

Aktualizacje idą tylko przez App Store (aplikacja nie ma własnego mechanizmu aktualizacji, zgodnie z wytycznymi).

## Polecenia w skrócie

| Polecenie | Co robi |
|---|---|
| `npm run appstore -- local` | wersja z sandboxem do testów, bez konta |
| `npm run appstore -- local --universal` | to samo dla Apple Silicon + Intel |
| `npm run appstore -- check` | czego brakuje do wysyłki |
| `npm run appstore -- build` | podpisana paczka `.pkg` do App Store |
| `npm run appstore -- upload` | walidacja i wysyłka paczki |
| `npm run media -- appstore` | nowe zrzuty ekranu (wymaga `npm run dev`) |
