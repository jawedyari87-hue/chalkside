package io.github.jawedyari87_hue.chalkside;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * A WebView set up for Chalkside's own pages: storage and the microphone work, the app's
 * bridge is available as window.ChalksideAndroid, and links to other sites open in the browser.
 */
final class Web {
    interface Listener {
        /** The page's renderer crashed or was killed, so this WebView can't be used again. */
        void onRendererGone(WebView view);
    }

    private Web() {}

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface", "AddJavascriptInterface"})
    static WebView create(Context ctx, String url, Object bridge, Listener listener) {
        if (BuildInfo.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        final String origin = App.origin(url);
        final Context app = ctx.getApplicationContext();
        WebView web = new WebView(ctx);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // The tutor starts talking without a tap on the page: you started the lesson in the app.
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString() + " ChalksideAndroid/" + BuildInfo.VERSION_NAME);
        web.addJavascriptInterface(bridge, "ChalksideAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (origin.equals(App.origin(u.toString()))) return false;
                // Other sites (such as Google AI Studio's key page) open in the browser, never in here.
                try {
                    app.startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (RuntimeException e) {
                    Log.w(App.TAG, "Nothing can open " + u, e);
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (!req.isForMainFrame()) return;
                Log.w(App.TAG, "Couldn't load " + req.getUrl() + ": " + err.getDescription());
                view.loadDataWithBaseURL(url, offlinePage(url), "text/html", "utf-8", null);
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                Log.w(App.TAG, "The page's renderer stopped (crashed: " + detail.didCrash() + ")");
                listener.onRendererGone(view);
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // The page's getUserMedia: allowed for Chalkside's own page once Android has granted the microphone.
            @Override
            public void onPermissionRequest(PermissionRequest req) {
                boolean ours = origin.equals(App.origin(req.getOrigin().toString()));
                boolean mic = app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
                for (String r : req.getResources()) {
                    if (ours && mic && PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                        req.grant(new String[] {r});
                        return;
                    }
                }
                req.deny();
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i(App.TAG, "[page] " + m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
        return web;
    }

    /** Shown when the site can't be reached: small enough for the floating bar. */
    private static String offlinePage(String url) {
        return "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<style>body{margin:0;font:600 15px system-ui,sans-serif;color:#edf1e7;background:transparent}"
                + ".bar{display:flex;align-items:center;gap:10px;width:max-content;margin:6px;padding:6px 6px 6px 18px;"
                + "border-radius:999px;background:#213a33}"
                + "a,button{font:inherit;border:0;border-radius:20px;padding:9px 14px;text-decoration:none}"
                + "a{background:#5fb39a;color:#0d1a15}button{background:none;color:#edf1e7}</style>"
                + "<div class=bar>Can't reach Chalkside<a href='" + url.replace("'", "%27") + "'>Retry</a>"
                + "<button onclick='ChalksideAndroid.stop()' aria-label='Close'>&#x2715;</button></div>";
    }
}
