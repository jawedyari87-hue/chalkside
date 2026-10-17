package io.github.jawedyari87_hue.chalkside;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.FrameLayout;

/**
 * The web app's own settings form (?overlay&settings): API key, voice, model, how much help.
 * It shares the floating window's storage, so whatever is saved here is what the tutor uses.
 */
public class SettingsActivity extends Activity {
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        getWindow().setBackgroundDrawable(new ColorDrawable(night ? 0xFF1A201E : 0xFFF7F9F5));

        FrameLayout root = new FrameLayout(this);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        });
        String url = App.page("overlay&settings");
        web = Web.create(this, url, new Bridge(), view -> runOnUiThread(this::finish));
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        // Dark status bar icons on the light page (the window must exist first, so after setContentView).
        WindowInsetsController bars = getWindow().getInsetsController();
        if (bars != null) {
            int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            bars.setSystemBarsAppearance(night ? 0 : light, light);
        }
        web.loadUrl(url);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        finish();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** window.ChalksideAndroid on the settings page. */
    final class Bridge {
        @JavascriptInterface
        public void settingsClosed(boolean hasKey) {
            runOnUiThread(() -> {
                App.prefs(SettingsActivity.this).edit().putBoolean("hasKey", hasKey).apply();
                // A lesson in progress picks up the new settings (or starts, if this added the key).
                if (TutorService.running) {
                    startService(new Intent(SettingsActivity.this, TutorService.class).setAction(TutorService.ACTION_SETTINGS));
                }
                finish();
            });
        }

        @JavascriptInterface
        public void stop() {
            runOnUiThread(SettingsActivity.this::finish);
        }
    }
}
