# Storagelyzer — notatki techniczne

*Opis dla użytkowników (po angielsku): [README](../README.md).*

Analizator zajętości dysku dla macOS w stylu **Disk Usage Analyzer (Baobab) z Ubuntu**: cały dysk/folder to koło, każdy kolejny pierścień to głębszy poziom folderów. Najedź na wycinek, żeby zobaczyć nazwę, rozmiar i udział; kliknij, żeby wejść głębiej (z animacją przybliżenia); kliknij środek, żeby wrócić wyżej. Po lewej drzewo folderów posortowane od największych.

Zbudowane na **Tauri 2** (Rust + WebView) i React/TypeScript.

## Uruchomienie

Wymagania: Rust (stable), Node 20+, Xcode Command Line Tools.

```bash
npm install
npm run tauri dev          # aplikacja w trybie deweloperskim
npm run tauri build        # .app + .dmg w src-tauri/target/release/bundle/
```

Universal binary (Apple Silicon + Intel):

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

Sam interfejs (bez Rusta, z wygenerowanym przykładowym „Macintosh HD”) można rozwijać w przeglądarce: `npm run dev` → http://localhost:1420. Z tego podglądu powstają też zrzuty i GIF-y do README: `npm run media` (headless Chrome przez DevTools Protocol + ffmpeg; `/?shot` dorysowuje przyciski okna).

Folder można też podać przy starcie — aplikacja od razu go zeskanuje:

```bash
open -a Storagelyzer --args ~/Downloads
./src-tauri/target/release/bundle/macos/Storagelyzer.app/Contents/MacOS/storagelyzer /Applications
open -a Storagelyzer --args --cleanup     # od razu asystent „Zwolnij miejsce”
```

**Instalacja nowej wersji:** `npm run install-app` buduje aplikację i *przenosi* ją do `/Applications`. Przenosi, a nie kopiuje: druga kopia z tym samym identyfikatorem w folderze build sprawia, że `open -a Storagelyzer` potrafi uruchomić właśnie ją (LaunchServices wybiera między kopiami). Paczka jest podpisana ad-hoc (`signingIdentity: "-"`), więc macOS wiąże Pełny dostęp do dysku z konkretną kompilacją — po każdej instalacji wyłącz i włącz uprawnienie w Ustawieniach. Trwałe rozwiązanie: certyfikat „Apple Development” (Xcode → Settings → Accounts) i `APPLE_SIGNING_IDENTITY` / `signingIdentity` w `tauri.conf.json`.

> **Pełny dostęp do dysku.** Bez niego macOS nie pozwala policzyć m.in. Poczty, Wiadomości, Safari i danych innych aplikacji. Aplikacja wykrywa brak uprawnienia i otwiera właściwy panel Ustawień. W `tauri dev` uprawnienie dotyczy **terminala**, z którego uruchomiono program.

## Funkcje

- wykres pierścieniowy (sunburst) na Canvas: kolor zależny od kąta jak w Baobabie, głębsze poziomy jaśniejsze/ciemniejsze, pliki w stonowanych barwach, drobne elementy zgrupowane w szary wycinek „Mniejsze elementy”,
- płynne przybliżanie/oddalanie, okruszki ścieżki, ⌘↑ / ⌫ = poziom wyżej,
- **wykres rośnie na żywo w trakcie skanowania — płynnie**: kolejne stany przechodzą w siebie (segmenty dopasowane po id rosną i przesuwają się, nowe wyłaniają się w obrębie rodzica, znikające zwijają się i gasną; `buildMorph` w `ring/layout.ts`), pierwszy obraz rysuje się zgodnie z ruchem wskazówek zegara, nieprzeskanowane jeszcze foldery delikatnie pulsują, licznik w środku odlicza zamiast skakać; to samo przejście działa przy zmianie Na dysku/Rozmiar i po usunięciu elementu,
- drzewo folderów z kolumnami Rozmiar / Udział / Elementy / Zmodyfikowano, wirtualizowane (setki tysięcy wierszy), obsługa klawiatury (↑↓←→, Enter, Spacja = Quick Look, ⌘⌫ = Kosz),
- menu kontekstowe: Otwórz, Pokaż w Finderze, Szybki podgląd, Kopiuj ścieżkę, Skanuj ponownie ten folder, Przenieś do Kosza (z potwierdzeniem),
- przełącznik **Na dysku** (zaalokowane bloki, jak `du`) / **Rozmiar** (logiczny, jak w Finderze),
- ekran startowy z folderem domowym i woluminami (zajętość), wybór folderu, przeciągnij-i-upuść folder na okno,
- pasek nad listą: **↑ poziom wyżej** i akcje dla zaznaczonego elementu (**Do Kosza**, Pokaż w Finderze); na wykresie przycisk „↑ W górę: …”; boczny przycisk „wstecz” myszy też cofa,
- **Kosz**: po przeniesieniu plików na dole pojawia się „Kosz: X GB” — kliknięcie opróżnia Kosz (z potwierdzeniem), bo dopiero wtedy miejsce wraca,
- **oba rozmiary naraz** (na dysku i logiczny) na pasku statusu i w dymkach; oznaczenie plików rzadkich (obrazy dysków Dockera/VM) i skompresowanych — stąd biorą się „1,6 TB” na dysku 1 TB w trybie „Rozmiar”. Kliknięcie „Rozmiar: …” (albo „Dlaczego?” pod wykresem) pokazuje okno z wyjaśnieniem na konkretnych plikach tego Maca (`Tree::size_gap`: różnica rozbita na pliki rzadkie, tylko w iCloud, skompresowane, z listą największych różnic),
- **asystent „Zwolnij miejsce”** (z ekranu startowego albo z paska narzędzi) — patrz niżej,
- lista folderów bez dostępu, informacja ile zajętego miejsca na woluminie skan „nie widzi” (migawki, purgeable, dane systemowe),
- jasny i ciemny motyw, interfejs po polsku lub angielsku (wg języka systemu, z przełącznikiem PL/EN na ekranie startowym).

## Asystent „Zwolnij miejsce”

„Dane systemowe” w ustawieniach macOS to w praktyce rzeczy, które rosną po cichu w znanych miejscach. Asystent mierzy je (tym samym szybkim skanerem, ~1–2 s) i dzieli na grupy:

| Grupa | Co | Akcja |
|---|---|---|
| Kosz | `~/.Trash` | Opróżnij Kosz (trwale, z potwierdzeniem) |
| Bezpieczne (zaznaczone) | pamięć podręczna aplikacji: `~/Library/Caches` **i** `Library/Caches` w kontenerach sandboxa zainstalowanych aplikacji (zawartość, sam folder zostaje); pamięć podręczna aplikacji webowych (Chromium/Electron: Chrome, Edge, Brave, Slack, Discord, VS Code, Teams…), `~/Library/Logs`, Xcode DerivedData i Device Support, cache symulatorów, cache npm/pnpm/Yarn/Bun/Cargo/Gradle/Maven/Go/CocoaPods, stare aktualizacje iOS, załączniki Poczty | Przenieś do Kosza |
| Bezpieczne (polecenie) | Homebrew — stare wersje i cache (rozmiar z `brew cleanup -n`) | `brew cleanup --prune=all` |
| Do przejrzenia | kopie iPhone'a (z nazwą urządzenia i datą), archiwa Xcode, instalatory w Pobranych, `~/.cache` (uv, Hugging Face…), `node_modules` i katalogi build projektów (np. Rust `target/` — wg `CACHEDIR.TAG`), największe pliki, **aplikacje** wg rozmiaru z datą ostatniego otwarcia, **dane aplikacji** (największe foldery w `~/Library/Application Support`, kontenerach, `/Library/Application Support` — np. biblioteki dźwięków Logic i GarageBand —, `/Library/Audio`, `/Library/Developer`) z oznaczeniem **pozostałości po odinstalowanych aplikacjach**, Docker (info) | Przenieś do Kosza / tylko podgląd |
| Do przejrzenia (polecenie) | symulatory iOS | `xcrun simctl delete unavailable` |
| Systemowe | lokalne migawki Time Machine | `tmutil deletelocalsnapshots /` (hasło administratora) |

**Uniwersalnie, nie z listy aplikacji.** Reguły opierają się na tym, co macOS daje każdej aplikacji, a nie na nazwach konkretnych programów:

- pamięć podręczna — foldery `Caches` (globalny i w kontenerze sandboxa każdej aplikacji);
- cache aplikacji webowych — po układzie katalogów Chromium/Electron (`Code Cache`, `GPUCache`, `Dawn*Cache`, `Service Worker/CacheStorage`, a samo `Cache` tylko obok innych folderów profilu Chromium), pogrupowane per aplikacja;
- nazwy aplikacji i „czy jest zainstalowana?” — z **LaunchServices** (`LSCopyApplicationURLsForBundleIdentifier`; rozszerzenia i pomocniki przez krótsze prefiksy identyfikatora, np. `com.getdropbox.dropbox.fileprovider` → Dropbox); kontener, którego identyfikatora nie zna już żadna aplikacja (poza `com.apple.*`), to pozostałość po odinstalowanej aplikacji;
- „kiedy ostatnio otwierana” — ze **Spotlighta** (`kMDItemLastUsedDate`); aplikacje nieotwierane od pół roku są wyróżnione.

Dzięki temu Logic, GarageBand, Blender, Steam czy aplikacja, której nikt tu nie przewidział, pojawią się same — z rozmiarem aplikacji, jej danych i (jeśli dotyczy) pamięci podręcznej.

Zasady bezpieczeństwa: pliki trafiają **do Kosza** (da się je odzyskać); backend przenosi do Kosza tylko ścieżki zwrócone przez ostatnią analizę; dane zainstalowanych aplikacji i aplikacje należące do roota (App Store, instalatory) są tylko do podglądu (`locked`); bez Pełnego dostępu chronione miejsca (w tym kontenery innych aplikacji) są pomijane zamiast zasypywać monitami; `node_modules`/`target` i duże pliki są szukane tylko w Twoich folderach (nie w `~/Library`, ukrytych folderach narzędzi ani w pakietach aplikacji). Ten sam plik w dwóch kategoriach (np. instalator, który jest też dużym plikiem) liczy się do sumy raz.

## Rozmiar aplikacji

| | |
|---|---|
| `Storagelyzer.app` (Apple Silicon) | **~4,8 MB** (plik wykonywalny ~4,5 MB z wbudowanym interfejsem ~0,3 MB, ikona 0,3 MB) |
| obraz `.dmg` (skompresowany) | **~2,8 MB** |
| universal (Apple Silicon + Intel) | ~9–10 MB |
| pamięć RAM | ~130 MB przy 410 tys. plików (+ proces WebKit); drzewo ~48 B/plik |

Tauri korzysta z systemowego WebKitu, więc nie dołącza przeglądarki — dla porównania aplikacje w Electronie (Chromium + Node) ważą 150–600 MB (np. Visual Studio Code 1,5 GB na tym Macu).

## Architektura

```
┌──────────────── WebView (React + TS) ────────────────┐
│ StartScreen   ScanView ─ TreeList (lista)            │
│                        └ RingChart (Canvas, sunburst)│
│        ▲ invoke() / Channel (postęp co 150 ms)       │
└────────┼─────────────────────────────────────────────┘
┌────────┴──────────── Rust (src-tauri) ───────────────┐
│ commands.rs  API: start_scan, get_rings, get_children │
│ scan/        równoległy skaner (rayon, 4 wątki)       │
│   fs.rs      getattrlistbulk(2) + fallback readdir    │
│ tree.rs      arena węzłów ~48 B/węzeł, rozmiary       │
│              propagowane do przodków na bieżąco       │
│ volumes.rs   getfsstat/statfs, kontenery APFS         │
│ cleanup.rs   asystent „Zwolnij miejsce”               │
│ apps.rs      LaunchServices, Spotlight, CFBundle      │
│ macos.rs     Full Disk Access, Finder, Kosz, QuickLook│
└──────────────────────────────────────────────────────┘
```

Całe drzewo plików zostaje w Ruście — do UI trafia tylko to, co widać: przycięte poddrzewo do wykresu (6 poziomów, wycinki ≥ 0,2% → maks. kilka tysięcy segmentów) i strony dzieci dla listy. Dzięki temu skan milionów plików nie zapycha IPC ani pamięci WebView.

## Jak podejść do tego uniwersalnie na macOS (plan)

Rzeczy, które odróżniają porządny analizator dysku na Macu od „rekurencyjnego `du`”:

1. **Szybkie wyliczanie katalogów — `getattrlistbulk(2)`.** Jedno wywołanie zwraca nazwy, typy, rozmiary, i-węzły i status montowania wielu wpisów naraz, zamiast `readdir` + `lstat` na każdy plik. Pomiar na tym Macu: `/Applications` (410 tys. elementów) 0,55 s vs `du` 3,6 s; wyniki zgodne z `du -sk` co do bajta.
2. **Nie przesadzać z wątkami.** APFS nie skaluje enumeracji katalogów: 4 wątki to optimum, 16 wątków jest 2–5× *wolniejsze* (zmierzone też bez żadnych blokad po stronie aplikacji — `examples/rawwalk.rs`). Domyślnie 4, nadpisywane `STORAGELYZER_THREADS`.
3. **Grupa woluminów System/Data i firmlinki.** Od Cataliny `/Users`, `/Applications`, `/Library`… to firmlinki do `/System/Volumes/Data`. Skanując „Macintosh HD” trzeba unikać liczenia ich dwa razy: katalogi deduplikowane po `(dev, ino)` z `fstat` (listing pokazuje i-węzeł „zaślepki”, `fstat` — prawdziwy), a punkty montowania z tego samego kontenera APFS (Data, VM, Preboot, Recovery) skanowane w drugiej fazie, a cele firmlinków z systemowej listy `/usr/share/firmlinks` pomijane — dane lądują pod znajomymi ścieżkami i nic nie liczy się podwójnie (także przy ponownym skanie podfolderu).
4. **Granice woluminów.** Nie wchodzimy na inne dyski, udziały sieciowe, `devfs` ani `autofs` (kontener rozpoznawany po `f_mntfromname`, np. `disk3s5` → `disk3`); automounty nie są wyzwalane (`setiopolicy_np(IOPOL_TYPE_VFS_TRIGGER_RESOLVE)`).
5. **Rozmiar na dysku vs logiczny.** Domyślnie zaalokowane bloki (pliki rzadkie, kompresja APFS/HFS), przełącznik na rozmiar logiczny. Twarde dowiązania liczone raz.
6. **iCloud / File Provider.** Pliki „dataless” (tylko w chmurze) liczone z lokalnym rozmiarem (zwykle 0), foldery dataless pomijane; wątki skanera mają wyłączone pobieranie (`IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES`), więc skan **nigdy nie ściąga** danych z iCloud. Nie aktualizujemy też czasów dostępu.
7. **Prywatność (TCC).** Aplikacja nie jest sandboxowana (dystrybucja poza App Store: Developer ID + notaryzacja). Wykrywa brak Pełnego dostępu do dysku i prowadzi do Ustawień; `Info.plist` ma opisy dla monitów o Biurko/Dokumenty/Pobrane/dyski wymienne/sieć. Foldery bez dostępu są oznaczone i wylistowane.
8. **„Ukryte” miejsce.** Dla woluminów pokazujemy różnicę między zajętym miejscem (`statfs`) a zeskanowanym: lokalne migawki Time Machine, purgeable, metadane APFS, katalogi tylko dla roota.
9. **Pamięć.** Arena ~48 B na węzeł + nazwa (2 mln plików ≈ 140 MB); spójna w trakcie skanu, więc UI rysuje na żywo.

### Kolejne kroki (roadmapa)

- **Klony APFS**: dziś sklonowane pliki (`cp -c`, duplikaty z Findera) liczą się wielokrotnie, jak w `du`. Atrybut `ATTR_CMNEXT_PRIVATESIZE` (getattrlist, macOS 10.15+) daje rozmiar „prywatny” — co faktycznie zwolni usunięcie.
- **Migawki i purgeable**: lista `tmutil listlocalsnapshots /`, `NSURLVolumeAvailableCapacityForImportantUsageKey` dla prawdziwej wolnej przestrzeni.
- **Tryb administratora**: helper uprzywilejowany (`SMAppService`) do skanowania katalogów tylko dla roota.
- **Widok mapy kafelkowej (treemap)** jako alternatywa dla koła (Baobab ma oba).
- **Odświeżanie przyrostowe przez FSEvents** zamiast ponownego skanu + cache ostatniego skanu.
- Kategorie (wideo, deweloperskie: `node_modules`, `DerivedData`, symulatory…), wyszukiwarka, eksport CSV.
- Podpis i notaryzacja w CI, auto-update (`tauri-plugin-updater`).

## Testy

```bash
cd src-tauri
cargo test                                             # model drzewa, skaner, woluminy, reguły czyszczenia
cargo run --release --example scan -- /Applications    # porównaj z: du -sk /Applications
cargo run --release --example listdir -- /System/Volumes  # co zwraca getattrlistbulk
cargo run --release --example cleanup                  # co znalazłby asystent czyszczenia
```
