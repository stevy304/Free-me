# Free Me for Android

`android/` is the Android app: a **Trusted Web Activity**, the standard way to put a website in an Android app. It
opens the Free Me site full screen from its own icon. The app is the site, so every change to Free Me reaches the
app at once, with no new APK. A new APK is only needed for a new icon, name or address.

Phones whose browser cannot open it that way (no recent Chrome, for example) open Free Me in a built-in web view.
iPhones cannot install APK files: they add Free Me to the home screen from Safari (the `/app` page explains how).

## Getting the APK to people

1. **Build it.** The GitHub workflow **Android app** (`.github/workflows/android.yml`) runs:
   - on every change under `android/`;
   - by hand: Actions → Android app → Run workflow, with a version such as 1.0.0.

   Download its result **free-me-apk** (a zip holding `free-me-<version>.apk`).
2. **Publish it.** Administration → **Android app**: choose the APK, type its version, Upload.
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
- **Full screen.** Administration → Android app → Full screen: the package name (`rw.freeme.app`) and the key's
  SHA-256 fingerprint. The workflow's summary shows it. Free Me then serves `/.well-known/assetlinks.json`, and Android
  hides the browser address bar.

## Google Play later

The same project can be published on Google Play (`./gradlew bundleRelease` makes the bundle Play wants). Play signs
apps with its own key: add Play's fingerprint (Play Console → App integrity) next to yours in Administration.
