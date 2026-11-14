# Free Me for Android

`android/` is the Android app: Free Me in the app's own full-screen window (Android's WebView), like the desktop
app. There is no browser address bar and it uses the phone layout. The back button goes back, videos go full
screen, uploads work, and the camera and microphone work for going live. Links to other sites open in the phone's
browser. The app shows the live site, so every change to Free Me reaches it at once without a new APK. A new APK
is only needed for a new icon, name or address.

**Which site it opens:**
- A build made for a site (`FREEME_HOST`, or the address given when the workflow is run by hand) opens it directly.
- A build made without one asks for the address the first time it opens and remembers it. This is for testing, such
  as a GitHub Codespace (its port must be Public). If the site cannot be reached, it offers "Try again" and "Change
  the address".

iPhones cannot install APK files: they add Free Me to the home screen from Safari (the `/app` page explains how).

## Getting the APK to people

1. **Build it.** The GitHub workflow **Android app** (`.github/workflows/android.yml`) runs:
   - on every change under `android/`;
   - by hand: Actions → Android app → Run workflow, with a version such as 1.0.0.

   Download its result **free-me-apk** (a zip holding `free-me-<version>.apk`).
2. **Publish it.** Automatic: on `main` (with `FREEME_HOST` set) the workflow publishes the APK as the GitHub
   release **android-latest** (`…/releases/download/android-latest/free-me.apk`), and Free Me's Download button
   offers it (the API checks it exists, every 10 minutes). To offer a different APK instead, upload it in
   Administration → **Android app** (an upload always wins). `ANDROID_APK_URL` on the API points the button at
   another address, or `off` turns the published build off.
3. **People download it** from:
   - the account menu ("Get the app");
   - the You page;
   - `/app`.

   The download link `/api/app/android/download` always points at the latest upload.

## Settings (once)

In the GitHub repository: Settings → Secrets and variables → Actions.

- **Variable `FREEME_HOST`**: the site's address without https://, for example `freeme.rw`. Without it the APK opens
  localhost (a test build).
- **Signing key.** Every version must be signed with the same key, or phones refuse to install an update over the
  old app. Make it once, on a computer with Java:

  ```bash
  keytool -genkeypair -v -keystore free-me.jks -alias free-me -keyalg RSA -keysize 4096 -validity 10000
  ```

  Then add four secrets:
  - `ANDROID_KEYSTORE_BASE64`: the output of `base64 -w0 free-me.jks`;
  - `ANDROID_KEYSTORE_PASSWORD`: the keystore password;
  - `ANDROID_KEY_ALIAS`: `free-me`;
  - `ANDROID_KEY_PASSWORD`: the key password.

  Keep `free-me.jks` and its passwords somewhere safe outside GitHub too. A lost key means people must uninstall the
  app to get a new one.
- **Links into the app (optional).** Administration → Android app → Full screen: the package name (`rw.freeme.app`)
  and the key's SHA-256 fingerprint (the workflow's summary shows it). Free Me then serves
  `/.well-known/assetlinks.json`, so Android can open Free Me links straight in the app.

## Google Play later

The same project can be published on Google Play (`./gradlew bundleRelease` makes the bundle Play wants). Play signs
apps with its own key: add Play's fingerprint (Play Console → App integrity) next to yours in Administration.
