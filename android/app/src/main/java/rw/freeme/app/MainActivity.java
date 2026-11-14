package rw.freeme.app;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.content.pm.PackageInfo;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceResponse;
import android.webkit.RenderProcessGoneDetail;
import android.view.WindowInsets;
import android.widget.ProgressBar;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * Free Me for Android (ANDROID.md): the Free Me site in the app's own full-screen window (a WebView, like the desktop
 * app), not in a browser. The phone layout, no address bar; the back button goes back; videos go full screen; file
 * uploads, the camera and the microphone (going live) work; links to other sites open in the phone's browser.
 *
 * The site: the address the build was made for (FREEME_HOST), else the one typed the first time the app opens
 * (testing, such as a GitHub Codespace), remembered until changed.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "freeme";
    private static final String KEY = "url";
    private static final int FILES = 1;
    private static final int MEDIA = 2;
    private static final int INK = Color.parseColor("#14110F");

    private WebView web;
    private String home;
    private ValueCallback<Uri[]> files;
    private PermissionRequest pendingMedia;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenDone;
    private FrameLayout root;
    private View loading;
    private boolean shown;
    private final Handler later = new Handler(Looper.getMainLooper());
    /** The site's styles need a recent WebView (Chrome 111+, as Tailwind v4 does); older ones show a dark, empty page. */
    private static final int WEBVIEW_NEEDED = 111;
    private boolean oldWebViewAccepted;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(INK);
        getWindow().setNavigationBarColor(INK);
        root = new FrameLayout(this);
        root.setBackgroundColor(INK);
        // Android 15 draws apps under the status and navigation bars: keep Free Me between them.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (fullscreen != null) v.setPadding(0, 0, 0, 0);
            else if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
            } else v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(root);

        String fixed = getString(R.string.launch_url);
        String saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY, null);
        home = !fixed.isEmpty() ? fixed : saved;
        // A Free Me link opened from elsewhere (a message, a search result) opens here.
        Uri link = getIntent().getData();
        String start = home != null && link != null && sameSite(link, Uri.parse(home)) ? link.toString() : home;
        if (start == null) ask(null);
        else if (webViewTooOld() > 0) oldWebView(start);
        else browse(start, state);
    }

    /** The phone's WebView (Chrome) major version when it is too old for the site, else 0. */
    private int webViewTooOld() {
        if (oldWebViewAccepted) return 0;
        try {
            PackageInfo p = Build.VERSION.SDK_INT >= 26 ? WebView.getCurrentWebViewPackage() : null;
            if (p == null || p.versionName == null) return 0;
            int major = Integer.parseInt(p.versionName.split("\\.")[0]);
            return major < WEBVIEW_NEEDED ? major : 0;
        } catch (RuntimeException e) { return 0; }
    }

    // ---- The site ---------------------------------------------------------------------------------------------

    private void browse(String url, Bundle state) {
        web = new WebView(this);
        web.setBackgroundColor(INK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // The phone layout, and a name the site can recognise.
        s.setUserAgentString(s.getUserAgentString() + " FreeMeApp/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
                // mailto:, tel:, whatsapp:, intent: … belong to other apps.
                if (!scheme.equals("http") && !scheme.equals("https")) { outside(u); return true; }
                // Everything stays inside the app: Free Me, its redirects and sign-ins (GitHub for a Codespace).
                // Only a link the person taps to another website opens in the phone's browser.
                boolean tapped = Build.VERSION.SDK_INT < 24 || (req.hasGesture() && !req.isRedirect());
                if (!tapped || (home != null && sameSite(u, Uri.parse(home))) || internal(u)) return false;
                outside(u);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError error) {
                if (req.isForMainFrame()) offline(error.getDescription() == null ? "" : error.getDescription().toString());
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse res) {
                // A stopped Codespace (502), a port that is not Public (401/403/404): say so instead of a blank page.
                if (!shown && req.isForMainFrame() && res.getStatusCode() >= 400) offline("The site answered " + res.getStatusCode() + (home != null && home.contains(".github.dev") ? ". Is the Codespace running, and its port set to Public?" : "."));
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                offline("The site's security certificate is not valid.");
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) { ready(); }

            @Override
            public void onPageFinished(WebView view, String url) { ready(); }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The page's process crashed (low memory): start it again rather than leave a dead, dark window.
                if (web == view) { web = null; root.removeView(view); }
                view.destroy();
                browse(home, null);
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (files != null) files.onReceiveValue(null);
                files = callback;
                try {
                    startActivityForResult(params.createIntent(), FILES);
                } catch (ActivityNotFoundException e) {
                    files = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback done) {
                if (fullscreen != null) { done.onCustomViewHidden(); return; }
                fullscreen = view;
                fullscreenDone = done;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
                immersive(true);
            }

            @Override
            public void onHideCustomView() { leaveFullscreen(); }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> media(request));
            }
        });

        // Downloads (the APK itself, a file someone shares) go to the phone's browser, which saves them.
        web.setDownloadListener((file, userAgent, contentDisposition, mimeType, length) -> outside(Uri.parse(file)));

        root.removeAllViews();
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        showLoading();
        if (state == null || web.restoreState(state) == null || web.copyBackForwardList().getSize() == 0) web.loadUrl(url);
    }

    /** Free Me's mark and a spinner over the page until it shows; after 20 s, ways out (a slow or stopped site). */
    private void showLoading() {
        shown = false;
        LinearLayout box = screen();
        box.setGravity(Gravity.CENTER);
        ProgressBar spin = new ProgressBar(this);
        box.addView(spin, new LinearLayout.LayoutParams(dp(48), dp(48)));
        TextView note = text("Opening Free Me…", "#B0A397", 15);
        note.setGravity(Gravity.CENTER);
        box.addView(note);
        loading = box;
        root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        later.removeCallbacksAndMessages(null);
        later.postDelayed(() -> {
            if (shown || loading != box) return;
            note.setText("This is taking long. A Codespace can need a minute to wake up.");
            Button retry = button("Try again", true);
            retry.setOnClickListener(v -> browse(home, null));
            box.addView(retry, wide());
            if (getString(R.string.launch_url).isEmpty()) {
                Button change = button("Change the address", false);
                change.setOnClickListener(v -> ask(home));
                box.addView(change, wide());
            }
        }, 20_000);
    }

    private void ready() {
        if (shown || web == null) return;
        shown = true;
        later.removeCallbacksAndMessages(null);
        if (loading != null) { root.removeView(loading); loading = null; }
    }

    /** The phone's WebView is too old to draw the site: offer the update (Google Play), or carry on. */
    private void oldWebView(String start) {
        LinearLayout box = screen();
        box.addView(text("Free Me needs a newer \"Android System WebView\" (this phone has version " + webViewTooOld() + "). Update it, and Chrome, in Google Play, then open Free Me again.", "#F4EDE3", 16));
        Button update = button("Update in Google Play", true);
        update.setOnClickListener(v -> {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.webview"))); }
            catch (ActivityNotFoundException e) { outside(Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.webview")); }
        });
        box.addView(update, wide());
        Button go = button("Open anyway", false);
        go.setOnClickListener(v -> { oldWebViewAccepted = true; browse(start, null); });
        box.addView(go, wide());
        root.removeAllViews();
        root.addView(box);
    }

    /** GitHub (a Codespace and its sign-in) stays in the app. */
    private static boolean internal(Uri u) {
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase();
        return host.equals("github.com") || host.endsWith(".github.com") || host.endsWith(".github.dev") || host.endsWith(".githubusercontent.com");
    }

    private static boolean sameSite(Uri a, Uri b) {
        return a.getHost() != null && a.getHost().equalsIgnoreCase(b.getHost()) && a.getPort() == b.getPort();
    }

    private void outside(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
    }

    private void immersive(boolean on) {
        root.requestApplyInsets();
        View d = getWindow().getDecorView();
        d.setSystemUiVisibility(on ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY : 0);
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void leaveFullscreen() {
        if (fullscreen == null) return;
        root.removeView(fullscreen);
        fullscreen = null;
        if (fullscreenDone != null) fullscreenDone.onCustomViewHidden();
        fullscreenDone = null;
        web.setVisibility(View.VISIBLE);
        immersive(false);
    }

    /** Camera and microphone for going live: asked of the person once, then given to the page. */
    private void media(PermissionRequest request) {
        List<String> need = new ArrayList<>();
        for (String r : request.getResources()) {
            if (r.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) need.add(Manifest.permission.CAMERA);
            if (r.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) need.add(Manifest.permission.RECORD_AUDIO);
        }
        List<String> missing = new ArrayList<>();
        for (String p : need) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
        if (missing.isEmpty()) { request.grant(request.getResources()); return; }
        if (pendingMedia != null) pendingMedia.deny();
        pendingMedia = request;
        requestPermissions(missing.toArray(new String[0]), MEDIA);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code != MEDIA || pendingMedia == null) return;
        boolean all = results.length > 0;
        for (int r : results) all &= r == PackageManager.PERMISSION_GRANTED;
        if (all) pendingMedia.grant(pendingMedia.getResources()); else pendingMedia.deny();
        pendingMedia = null;
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == FILES && files != null) {
            files.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            files = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (fullscreen != null) { leaveFullscreen(); return; }
        if (web != null && web.canGoBack()) { web.goBack(); return; }
        super.onBackPressed();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri link = intent.getData();
        if (web != null && link != null && home != null && sameSite(link, Uri.parse(home))) web.loadUrl(link.toString());
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onPause() { super.onPause(); if (web != null) web.onPause(); CookieManager.getInstance().flush(); }

    @Override
    protected void onResume() { super.onResume(); if (web != null) web.onResume(); }

    // ---- Screens before the site --------------------------------------------------------------------------------

    private int dp(int v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }

    private LinearLayout screen() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(dp(28), dp(28), dp(28), dp(28));
        box.setBackgroundColor(INK);
        TextView title = new TextView(this);
        title.setText("free◆me");
        title.setTextColor(Color.parseColor("#F4EDE3"));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 34);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        box.addView(title);
        TextView version = new TextView(this);
        version.setText("Free Me app " + BuildConfig.VERSION_NAME);
        version.setTextColor(Color.parseColor("#85786D"));
        version.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        box.addView(version);
        return box;
    }

    private TextView text(String s, String color, int sp) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextColor(Color.parseColor(color));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setPadding(0, dp(12), 0, dp(8));
        return t;
    }

    private Button button(String label, boolean primary) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(Color.parseColor(primary ? "#062320" : "#F4EDE3"));
        b.setBackgroundColor(Color.parseColor(primary ? "#22ADA2" : "#2A231F"));
        return b;
    }

    private LinearLayout.LayoutParams wide() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        lp.topMargin = dp(14);
        return lp;
    }

    /** The address of the Free Me to open (builds without one, or to change it). */
    private void ask(String current) {
        LinearLayout box = screen();
        box.addView(text("Which Free Me should this app open? Paste its address, for example https://your-codespace-3000.app.github.dev", "#B0A397", 15));
        final EditText field = new EditText(this);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setImeOptions(EditorInfo.IME_ACTION_GO);
        field.setSingleLine(true);
        field.setHint("https://…");
        if (current != null) field.setText(current);
        field.setTextColor(Color.parseColor("#F4EDE3"));
        field.setHintTextColor(Color.parseColor("#85786D"));
        box.addView(field);
        final TextView error = text("", "#FF6B6B", 14);
        box.addView(error);
        Button go = button("Open Free Me", true);
        box.addView(go, wide());
        Runnable submit = () -> {
            String url = normalize(field.getText().toString());
            if (url == null) { error.setText("That does not look like a web address."); return; }
            SharedPreferences.Editor e = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
            e.putString(KEY, url);
            e.apply();
            home = url;
            if (webViewTooOld() > 0) oldWebView(url); else browse(url, null);
        };
        go.setOnClickListener(v -> submit.run());
        field.setOnEditorActionListener((v, actionId, event) -> { submit.run(); return true; });
        root.removeAllViews();
        root.addView(box);
    }

    /** The site could not be reached: try again, or (a build without a fixed site) change the address. */
    private void offline(String why) {
        LinearLayout box = screen();
        box.addView(text("Free Me could not be reached. Check your connection and try again.", "#F4EDE3", 17));
        if (!why.isEmpty()) box.addView(text(why, "#85786D", 13));
        Button retry = button("Try again", true);
        retry.setOnClickListener(v -> browse(home, null));
        box.addView(retry, wide());
        if (getString(R.string.launch_url).isEmpty()) {
            Button change = button("Change the address", false);
            change.setOnClickListener(v -> ask(home));
            box.addView(change, wide());
        }
        later.removeCallbacksAndMessages(null);
        loading = null;
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        root.removeAllViews();
        root.addView(box);
    }

    /** "name-3000.app.github.dev" or "https://…/": the site's https address, or null. */
    static String normalize(String text) {
        String t = text.trim();
        if (t.isEmpty()) return null;
        if (!t.matches("(?i)^https?://.*")) t = "https://" + t;
        Uri u = Uri.parse(t);
        String host = u.getHost();
        if (host == null || !host.contains(".")) return null;
        return "https://" + host + (u.getPort() > 0 ? ":" + u.getPort() : "") + "/?source=android";
    }
}
