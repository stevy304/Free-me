package rw.freeme.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

/**
 * Opens Free Me (ANDROID.md). A build made for a site (FREEME_HOST) goes straight there. A build made without one
 * (for testing, such as a GitHub Codespace whose address changes) asks for the address the first time and remembers
 * it; clearing the app's storage asks again.
 */
public class StartActivity extends Activity {
    private static final String PREFS = "freeme";
    private static final String KEY = "url";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String fixed = getString(R.string.launch_url);
        if (!fixed.isEmpty()) { open(null); return; }
        String saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY, null);
        if (saved != null) { open(saved); return; }
        ask();
    }

    /** The Trusted Web Activity: the build's own address, or the one given here. */
    private void open(String url) {
        Intent intent = new Intent(this, LauncherActivity.class);
        if (url != null) { intent.setAction(Intent.ACTION_VIEW); intent.setData(Uri.parse(url)); }
        startActivity(intent);
        finish();
    }

    private int dp(int v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }

    private void ask() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(dp(28), dp(28), dp(28), dp(28));
        box.setBackgroundColor(Color.parseColor("#14110F"));

        TextView title = new TextView(this);
        title.setText("free◆me");
        title.setTextColor(Color.parseColor("#F4EDE3"));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 34);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        box.addView(title);

        TextView hint = new TextView(this);
        hint.setText("Which Free Me should this app open? Paste its address, for example https://your-codespace-3000.app.github.dev");
        hint.setTextColor(Color.parseColor("#B0A397"));
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        hint.setPadding(0, dp(12), 0, dp(16));
        box.addView(hint);

        final EditText field = new EditText(this);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setImeOptions(EditorInfo.IME_ACTION_GO);
        field.setSingleLine(true);
        field.setHint("https://…");
        field.setTextColor(Color.parseColor("#F4EDE3"));
        field.setHintTextColor(Color.parseColor("#85786D"));
        box.addView(field);

        final TextView error = new TextView(this);
        error.setTextColor(Color.parseColor("#FF6B6B"));
        error.setPadding(0, dp(8), 0, 0);
        box.addView(error);

        Button go = new Button(this);
        go.setText("Open Free Me");
        go.setAllCaps(false);
        go.setTextColor(Color.parseColor("#062320"));
        go.setBackgroundColor(Color.parseColor("#22ADA2"));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52));
        lp.topMargin = dp(16);
        box.addView(go, lp);

        Runnable submit = () -> {
            String url = normalize(field.getText().toString());
            if (url == null) { error.setText("That does not look like a web address."); return; }
            SharedPreferences.Editor e = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
            e.putString(KEY, url);
            e.apply();
            open(url);
        };
        go.setOnClickListener(v -> submit.run());
        field.setOnEditorActionListener((v, actionId, event) -> { submit.run(); return true; });
        setContentView(box);
    }

    /** "name-3000.app.github.dev", "https://…/" or "http://…": an https address of the host, or null. */
    static String normalize(String text) {
        String t = text.trim();
        if (t.isEmpty()) return null;
        if (!t.matches("(?i)^https?://.*")) t = "https://" + t;
        Uri u = Uri.parse(t);
        if (u.getHost() == null || !u.getHost().contains(".")) return null;
        String scheme = "http".equalsIgnoreCase(u.getScheme()) && (u.getHost().startsWith("192.168.") || u.getHost().startsWith("10.")) ? "http" : "https";
        return scheme + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "") + "/?source=android";
    }
}
