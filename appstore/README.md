# Storagelyzer on the Mac App Store

**English** · [Polski](README.pl.md)

Everything needed to put Storagelyzer on the Mac App Store as a free app. The "Now" part works without a developer account; "Once the account is active" is the list of steps for the day the Apple Developer Program membership starts.

## What is ready

| What | Where |
|---|---|
| The app runs in the App Sandbox (required by the Mac App Store) | `src-tauri/src/sandbox.rs`, plus changes in `macos.rs`, `volumes.rs`, `cleanup.rs` |
| Entitlements for the store and for local testing | `src-tauri/macos/AppStore.entitlements`, `Sandbox-local.entitlements` |
| Privacy manifest (required by Apple) | `src-tauri/macos/PrivacyInfo.xcprivacy` |
| English and Polish permission texts; they also make the store list both languages | `src-tauri/macos/{en,pl}.lproj/InfoPlist.strings` |
| No encryption, so no export compliance questions | `ITSAppUsesNonExemptEncryption = false` in `src-tauri/Info.plist` |
| Version 1.0.0 | `tauri.conf.json`, `Cargo.toml`, `package.json` |
| Build, signing, `.pkg`, upload | `scripts/appstore.sh` (`npm run appstore -- …`) |
| Screenshots, 2880 × 1800, English (also used by the Polish listing) | `appstore/screenshots/en-US/` (made by `npm run media -- appstore`) |
| Name, subtitle, description, keywords, links (English, Polish) | `appstore/metadata/` (laid out for `fastlane deliver`) |
| Notes for App Review | `appstore/metadata/review_information/notes.txt` |
| Privacy policy and support page | `docs/privacy.html`, `docs/support.html` (storagelyzer.wojciechbakun.pl) |

### How the App Store version differs from the build from source

The App Sandbox does not let an app read a disk without the user's permission, run other programs with the user's rights or ask for an administrator password. So:

- **Disk access.** The first time a disk or folder is opened, macOS shows an "Allow Access" panel. The choice is remembered (a security-scoped bookmark in the app's container), so it asks once. The start screen offers access to "Macintosh HD" right away.
- **Full Disk Access** works as before, but can only be detected once the disk is allowed.
- **Left out:** Homebrew clean-up, deleting unavailable simulators (their size is still measured) and deleting Time Machine snapshots, because these run `brew`, `xcrun` or `tmutil` with an administrator password.
- **No Quick Look**, because `qlmanage` does not start from the sandbox (tested). In the App Store version Return and double-click open a file instead.
- Finder, System Settings and the clipboard go through AppKit instead of `open` or `pbcopy`, in both versions.

The build from source (`npm run install-app`) works exactly as before: macOS decides which mode the app runs in (the `APP_SANDBOX_CONTAINER_ID` variable), not a separate code path.

## Now, without a developer account

### 1. Try the App Store version on your Mac

```bash
npm run appstore -- local
```

Builds the app with the same sandbox as in the store (signed ad hoc) into `src-tauri/target/appstore/local/Storagelyzer.app` and opens it. It does not replace `/Applications/Storagelyzer.app`. Its data and remembered permissions live in `~/Library/Containers/com.wojtek.storagelyzer`; to start from scratch, quit the app and delete that folder.

What to check (these are system windows, so this cannot be clicked through automatically):

- [ ] "Allow access to your disk" banner → "Allow Access…" → "Allow Access" in the panel. The banner disappears and Macintosh HD loses its "needs permission" tag.
- [ ] A scan of Macintosh HD gives about the same result as the version in `/Applications`.
- [ ] Quit and reopen: the app does not ask again.
- [ ] "Choose folder…" and dropping a folder on the window both scan that folder.
- [ ] "Free up space" lists categories (without Homebrew and Time Machine snapshots).
- [ ] "Move to Trash" on something unimportant (e.g. a file in `~/Library/Logs`), then put it back from the Trash.
- [ ] Right-click a row → "Show in Finder", "Open", "Copy path".
- [ ] Full Disk Access: System Settings → Privacy & Security → Full Disk Access → **+** → `src-tauri/target/appstore/local/Storagelyzer.app`, then reopen the app. The Full Disk Access banner goes away and "not accessible" in the status bar shrinks.
- [ ] An external drive (if you have one) asks for permission separately.

The sandboxed interface can also be seen in a browser: `npm run dev`, then `http://localhost:1420/?sandboxed`.

### 2. Publish the privacy and support pages

App Store Connect needs a privacy policy URL and a support URL. The store texts point to:

- https://storagelyzer.wojciechbakun.pl/privacy
- https://storagelyzer.wojciechbakun.pl/support

(the Polish listing adds `?lang=pl`, see `metadata/pl/*_url.txt`). Without it the pages are in English, with an EN/PL switch in the top right corner.

The site on that subdomain is a Cloudflare Worker serving the static files from `docs/`. It is deployed with `wdrozenia/aplikacje.sh storagelyzer`, which takes `docs/` from the commit currently checked out in the repository (so merge this branch into `main` and check it out first) and adds Cloudflare Web Analytics. The same pages reach GitHub Pages (wojtekbakun.github.io/storagelyzer) once merged into `main`. The support page and the privacy policy give wojciechbakundev@gmail.com and GitHub Issues as contacts.

## Once the account is active

### 3. Apple Developer Program

[developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/) → **Individual** membership on your Apple ID, with two-factor authentication on. It costs 99 USD a year. The store shows the account holder's legal name as the seller. Activation usually takes from a few hours to 2 days.

A free app does **not** need the "Paid Apps" agreement or tax and banking details. The agreement for free apps is part of the program agreement.

### 4. Certificates

Xcode → Settings → Accounts → your Apple ID → Manage Certificates… → **+**:

- **Apple Distribution** signs the app,
- **Mac Installer Distribution** signs the `.pkg` (it shows up in Keychain Access as "3rd Party Mac Developer Installer: …").

`security find-identity -v` prints their full names.

### 5. App ID and provisioning profile

[developer.apple.com/account/resources](https://developer.apple.com/account/resources/identifiers/list):

1. **Identifiers → +** → App IDs → App → description "Storagelyzer", Bundle ID **Explicit**: `com.wojtek.storagelyzer`, platform macOS. No extra capabilities (the sandbox is an entitlement, not a capability in the portal).
2. **Profiles → +** → Distribution → **Mac App Store Connect** → App ID `com.wojtek.storagelyzer` → the Apple Distribution certificate → download the `.provisionprofile`.

The bundle ID is permanent after the first upload. If you prefer another one (e.g. `com.wojtekbakun.storagelyzer`), change it now in `tauri.conf.json`, `scripts/appstore.sh` and `src-tauri/macos/AppStore.entitlements`.

### 6. Script settings

```bash
cp scripts/appstore.env.example scripts/appstore.env
```

Fill in the Team ID, the names of both certificates and the path to the profile. The file is in `.gitignore`. Then:

```bash
npm run appstore -- check
```

Everything should have a ✓ (the API key is optional).

### 7. The app in App Store Connect

[appstoreconnect.apple.com](https://appstoreconnect.apple.com) → Apps → **+** → New App:

| Field | Value |
|---|---|
| Platforms | macOS |
| Name | `Storagelyzer: Disk Analyzer` (if the name is taken, try e.g. `Storagelyzer – Disk Usage`) |
| Primary Language | English (U.S.) |
| Bundle ID | com.wojtek.storagelyzer |
| SKU | `storagelyzer` |
| User Access | Full Access |

### 8. Build and upload

```bash
npm run appstore -- build
```

Builds a universal app (Apple silicon + Intel), signs it with the profile and creates `dist-appstore/Storagelyzer-1.0.0-<build>.pkg`. The build number (`CFBundleVersion`) is the date and time, so every build gets a new one while the version stays 1.0.0.

Upload, either:

- with **Transporter** (Apple's free app on the Mac App Store): sign in, drop the `.pkg`, "Deliver";
- or with `npm run appstore -- upload` and an API key (App Store Connect → Users and Access → Integrations → App Store Connect API → a key with the Developer role; put `AuthKey_<ID>.p8` into `~/.appstoreconnect/private_keys/`, and `ASC_KEY_ID` and `ASC_ISSUER_ID` into `appstore.env`).

After 5–30 minutes the build appears under TestFlight. **Try TestFlight first**: add yourself as an internal tester, install the app through TestFlight on your Mac and go through the list from step 1 on the properly signed build.

### 9. The store listing

App Store Connect → Storagelyzer → version 1.0 (also add the **Polish** localization with the language menu in the top right):

| App Store Connect field | File |
|---|---|
| Name | `metadata/<locale>/name.txt` |
| Subtitle | `metadata/<locale>/subtitle.txt` |
| Promotional Text | `metadata/<locale>/promotional_text.txt` |
| Description | `metadata/<locale>/description.txt` |
| Keywords | `metadata/<locale>/keywords.txt` |
| Support URL | `metadata/<locale>/support_url.txt` |
| Marketing URL | `metadata/<locale>/marketing_url.txt` |
| Privacy Policy URL (App Information / App Privacy) | `metadata/<locale>/privacy_url.txt` |
| Screenshots (Mac) | `screenshots/en-US/*.png`, in file name order, in the English localization only; the Polish one shows them too |
| Copyright | `metadata/copyright.txt` |
| Category | Primary: Utilities, Secondary: Developer Tools (optional) |

The other sections:

- **App Privacy** → Get Started → "No, we do not collect data from this app" → Publish. The store label reads "Data Not Collected".
- **Age Rating**: "None" / "No" everywhere (no mature content, no user-generated content, no chat, no unrestricted web access, no ads). Result: 4+.
- **Pricing and Availability**: Price → **Free (0)**. Availability → all countries, except China mainland, which requires an ICP filing number; it is simplest to leave it out.
- **App Information → Content Rights**: "No, it does not contain, show, or access third-party content".
- **Digital Services Act** (Business → Compliance): your EU trader status. For a free hobby app people usually choose "not a trader"; a trader has to publish an address and phone number. It is your legal call; without an answer the app is not shown in EU countries.
- **Encryption**: no questions, `ITSAppUsesNonExemptEncryption = false` takes care of it.
- **App Review Information**: first and last name, phone, e-mail (only Apple sees them), "Sign-in required" unticked, Notes from `metadata/review_information/notes.txt`.
- **Version Release**: "Manually release this version", so you release 1.0 yourself after approval.

### 10. Submit for review

In version 1.0 pick the build from TestFlight → Add for Review → Submit. Review usually takes 1–2 days. The questions reviewers most often ask about an app like this, already answered in the notes:

- *Why `network.client`?* Without it WKWebView cannot start its helper processes in the sandbox (tested: without it the interface does not load). The app makes no network connections.
- *Why Full Disk Access?* It is optional; the app works without it and says what it could not read.
- *Does it delete other apps' data?* Only what the user picks, always to the Trash. Data of installed apps is shown for reference only.

## Later versions

1. Raise the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json` (e.g. 1.0.1).
2. `npm run appstore -- build`, then upload.
3. In App Store Connect: "+ Version", "What's New" text, pick the build, Submit.

Updates come only through the App Store (the app has no updater of its own, as the guidelines require).

## Commands

| Command | What it does |
|---|---|
| `npm run appstore -- local` | sandboxed test build, no account needed |
| `npm run appstore -- local --universal` | the same for Apple silicon + Intel |
| `npm run appstore -- check` | what is still missing for a submission |
| `npm run appstore -- build` | signed `.pkg` for the App Store |
| `npm run appstore -- upload` | validate and upload the package |
| `npm run media -- appstore` | new screenshots (needs `npm run dev`) |
