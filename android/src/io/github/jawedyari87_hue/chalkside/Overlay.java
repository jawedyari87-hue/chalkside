package io.github.jawedyari87_hue.chalkside;

import android.content.ComponentCallbacks;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.os.Handler;
import android.os.Looper;
import android.view.ContextThemeWrapper;
import android.view.Display;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.WindowMetrics;
import android.view.inputmethod.InputMethodManager;
import android.net.Uri;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * The floating window over other apps. It holds the web app in overlay mode (?overlay): a small
 * bar that the page sizes to fit, which opens into a panel of everything the tutor says and writes.
 * Drag the bar, or the top of the panel, to move it.
 */
final class Overlay {
    private static final int BUBBLE = 0, PANEL = 1;
    private static final int PANEL_HANDLE_DP = 60; // the top of the panel (the page's bar) moves it

    private final TutorService service;
    private final Context ctx;
    private final WindowManager wm;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final WindowManager.LayoutParams lp = new WindowManager.LayoutParams();
    private final String url;
    private DragFrame root;
    private WebView web;
    private int mode = BUBBLE;
    private int bubbleW, bubbleH;
    private boolean attached, focusable, keepOn;
    private volatile boolean captureWanted;

    Overlay(TutorService service) {
        this.service = service;
        DisplayManager dm = service.getSystemService(DisplayManager.class);
        Context display = service.createDisplayContext(dm.getDisplay(Display.DEFAULT_DISPLAY));
        Context window = display.createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null);
        ctx = new ContextThemeWrapper(window, R.style.Theme_Chalkside);
        wm = ctx.getSystemService(WindowManager.class);
        url = App.page("overlay");
        bubbleW = dp(360);
        bubbleH = dp(68);

        lp.type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
        lp.format = PixelFormat.TRANSLUCENT;
        lp.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
        lp.gravity = Gravity.TOP | Gravity.LEFT;
        lp.setFitInsetsTypes(0); // positions are screen pixels; safeArea() keeps the window clear of the bars
        lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
        lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING;
        lp.setTitle("Chalkside");

        ctx.registerComponentCallbacks(new ComponentCallbacks() {
            @Override
            public void onConfigurationChanged(Configuration c) {
                main.post(Overlay.this::applyLayout); // the tablet turned: keep the window on screen
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onLowMemory() {}
        });
    }

    void show() {
        createWebView();
        applyLayout();
        wm.addView(root, lp);
        attached = true;
        web.loadUrl(url);
    }

    void destroy() {
        if (!attached) return;
        attached = false;
        try {
            wm.removeView(root);
        } catch (RuntimeException ignored) {
            // already gone
        }
        web.destroy();
    }

    /** A message to the page: stop, blur, settings, screen-stopped or screen-started. */
    void send(String type) {
        main.post(() -> {
            if (attached) web.evaluateJavascript("window.chalksideNative&&chalksideNative('" + type + "')", null);
        });
    }

    boolean captureWanted() {
        return captureWanted;
    }

    private void createWebView() {
        root = new DragFrame(ctx);
        web = Web.create(ctx, url, new Bridge(), new Web.Listener() {
            @Override
            public void onRendererGone(WebView view) {
                main.post(Overlay.this::recreate);
            }

            // "Show the tutor a file": the page shrinks to the bar, and Android's picker opens.
            @Override
            public boolean onFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
                FilePickerActivity.open(service, callback, params, null);
                return true;
            }
        });
        web.setBackgroundColor(Color.TRANSPARENT);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        // Keep the typing box above the keyboard.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(0, 0, 0, insets.getInsets(WindowInsets.Type.ime()).bottom);
            return insets;
        });
    }

    // The page's renderer died (rare): start it again. The lesson itself is saved by the page.
    private void recreate() {
        if (!attached) return;
        try {
            wm.removeView(root);
        } catch (RuntimeException ignored) {
            // already gone
        }
        web.destroy();
        focusable = false;
        lp.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        createWebView();
        wm.addView(root, lp);
        web.loadUrl(url);
    }

    // ---- size and position ----

    /** The screen minus the status bar, navigation bar or taskbar and camera cutout, with a small margin. */
    private Rect safeArea() {
        WindowMetrics m = wm.getCurrentWindowMetrics();
        Rect r = new Rect(m.getBounds());
        Insets in = m.getWindowInsets().getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
        r.left += in.left;
        r.top += in.top;
        r.right -= in.right;
        r.bottom -= in.bottom;
        r.inset(dp(8), dp(8));
        return r;
    }

    private void applyLayout() {
        Rect safe = safeArea();
        SharedPreferences p = App.prefs(service);
        float bx = p.getFloat("bubbleX", 1f), by = p.getFloat("bubbleY", 0f);
        int w, h;
        float fx, fy;
        if (mode == BUBBLE) {
            w = bubbleW;
            h = bubbleH;
            fx = bx;
            fy = by;
        } else if (safe.width() > safe.height()) {
            // Landscape: a tall panel down one side, on the bar's side unless you've moved it.
            w = clamp(Math.round(safe.width() * 0.42f), dp(380), dp(720));
            h = safe.height();
            fx = p.getFloat("panelX", bx >= 0.5f ? 1f : 0f);
            fy = 0f;
        } else {
            // Portrait: the top or bottom half.
            w = safe.width();
            h = Math.round(safe.height() * 0.55f);
            fx = 0f;
            fy = p.getFloat("panelY", by >= 0.5f ? 1f : 0f);
        }
        lp.width = Math.min(w, safe.width());
        lp.height = Math.min(h, safe.height());
        lp.x = safe.left + Math.round(fx * Math.max(0, safe.width() - lp.width));
        lp.y = safe.top + Math.round(fy * Math.max(0, safe.height() - lp.height));
        update();
    }

    private void moveTo(int x, int y) {
        Rect safe = safeArea();
        lp.x = clamp(x, safe.left, Math.max(safe.left, safe.right - lp.width));
        lp.y = clamp(y, safe.top, Math.max(safe.top, safe.bottom - lp.height));
        update();
    }

    // Positions are kept as fractions of the free space, so they survive turning the tablet.
    private void savePosition() {
        Rect safe = safeArea();
        float fx = (lp.x - safe.left) / (float) Math.max(1, safe.width() - lp.width);
        float fy = (lp.y - safe.top) / (float) Math.max(1, safe.height() - lp.height);
        SharedPreferences.Editor e = App.prefs(service).edit();
        if (mode == BUBBLE) e.putFloat("bubbleX", clamp01(fx)).putFloat("bubbleY", clamp01(fy));
        else e.putFloat("panelX", clamp01(fx)).putFloat("panelY", clamp01(fy));
        e.apply();
    }

    private void update() {
        if (attached) wm.updateViewLayout(root, lp);
        ScreenCapture c = service.capture();
        if (c == null) return;
        c.setMask(new Rect(lp.x, lp.y, lp.x + lp.width, lp.y + lp.height));
        Insets bars = wm.getCurrentWindowMetrics().getWindowInsets().getInsetsIgnoringVisibility(WindowInsets.Type.systemBars());
        c.setSystemBars(bars.top, bars.bottom);
    }

    /** Called when a new screen capture starts, so it knows where this window is. */
    void captureChanged() {
        update();
        ScreenCapture c = service.capture();
        if (c != null) c.setActive(captureWanted);
    }

    private void setMode(String m, int cssW, int cssH) {
        mode = "panel".equals(m) ? PANEL : BUBBLE;
        if (mode == BUBBLE && cssW > 0 && cssH > 0) {
            float d = ctx.getResources().getDisplayMetrics().density; // a CSS pixel is a dp in the WebView
            bubbleW = Math.round(cssW * d);
            bubbleH = Math.round(cssH * d);
        }
        if (mode == BUBBLE) setFocusable(false);
        applyLayout();
    }

    // The window only takes keyboard focus while you type in it, so it never steals the
    // keyboard or the back button from the app underneath.
    private void setFocusable(boolean on) {
        if (focusable == on || !attached) return;
        focusable = on;
        if (on) lp.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        else lp.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        wm.updateViewLayout(root, lp);
        InputMethodManager imm = ctx.getSystemService(InputMethodManager.class);
        if (on) {
            web.requestFocus();
            main.postDelayed(() -> {
                if (focusable && attached) imm.showSoftInput(web, 0);
            }, 200);
        } else {
            imm.hideSoftInputFromWindow(root.getWindowToken(), 0);
        }
    }

    // The page calls this when the tutor starts and stops: keep the screen on, and send the volume buttons to its voice.
    private void keepScreenOn(boolean on) {
        service.setLessonLive(on);
        if (keepOn == on) return;
        keepOn = on;
        if (on) lp.flags |= WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON;
        else lp.flags &= ~WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON;
        update();
    }

    private int dp(int v) {
        return Math.round(v * ctx.getResources().getDisplayMetrics().density);
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    private static float clamp01(float v) {
        return Math.max(0f, Math.min(1f, v));
    }

    /** Drags move the window; taps and scrolls go to the page. */
    private final class DragFrame extends FrameLayout {
        private final int slop;
        private float downX, downY;
        private int startX, startY;
        private boolean canDrag, dragging;

        DragFrame(Context c) {
            super(c);
            slop = ViewConfiguration.get(c).getScaledTouchSlop();
        }

        @Override
        public boolean dispatchTouchEvent(MotionEvent e) {
            if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE) {
                // A tap in another app while typing here: give the keyboard back.
                if (focusable) {
                    setFocusable(false);
                    send("blur");
                }
                return true;
            }
            return super.dispatchTouchEvent(e);
        }

        @Override
        public boolean onInterceptTouchEvent(MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = e.getRawX();
                    downY = e.getRawY();
                    startX = lp.x;
                    startY = lp.y;
                    dragging = false;
                    canDrag = mode == BUBBLE || e.getY() < dp(PANEL_HANDLE_DP);
                    return false;
                case MotionEvent.ACTION_MOVE:
                    if (canDrag && !dragging && Math.hypot(e.getRawX() - downX, e.getRawY() - downY) > slop) {
                        dragging = true;
                        return true;
                    }
                    return false;
                default:
                    return false;
            }
        }

        @Override
        public void requestDisallowInterceptTouchEvent(boolean disallow) {
            if (!canDrag) super.requestDisallowInterceptTouchEvent(disallow);
        }

        @Override
        public boolean onTouchEvent(MotionEvent e) {
            if (!dragging) return super.onTouchEvent(e);
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_MOVE:
                    moveTo(startX + Math.round(e.getRawX() - downX), startY + Math.round(e.getRawY() - downY));
                    break;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    dragging = false;
                    savePosition();
                    break;
                default:
                    break;
            }
            return true;
        }

        @Override
        public boolean dispatchKeyEvent(KeyEvent e) {
            if (e.getKeyCode() == KeyEvent.KEYCODE_BACK) {
                if (e.getAction() == KeyEvent.ACTION_UP) {
                    setFocusable(false);
                    send("blur");
                }
                return true;
            }
            return super.dispatchKeyEvent(e);
        }
    }

    /** window.ChalksideAndroid in the page. These run on a WebView thread, so UI work is posted. */
    final class Bridge {
        @JavascriptInterface
        public String info() {
            return "{\"version\":\"" + BuildInfo.VERSION_NAME + "\",\"screen\":" + (service.capture() != null) + "}";
        }

        @JavascriptInterface
        public String frame(int since) {
            ScreenCapture c = service.capture();
            return c == null ? "" : c.frame(since);
        }

        @JavascriptInterface
        public void setMode(String mode, int w, int h) {
            main.post(() -> Overlay.this.setMode(mode, w, h));
        }

        @JavascriptInterface
        public void setFocusable(boolean on) {
            main.post(() -> Overlay.this.setFocusable(on));
        }

        @JavascriptInterface
        public void setCapture(boolean on) {
            captureWanted = on;
            ScreenCapture c = service.capture();
            if (c != null) c.setActive(on);
        }

        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            main.post(() -> Overlay.this.keepScreenOn(on));
        }

        @JavascriptInterface
        public void toast(String text) {
            main.post(() -> Toast.makeText(service, text, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void openSettings() {
            main.post(service::openSettings);
        }

        @JavascriptInterface
        public void settingsClosed(boolean hasKey) {
            // Only the settings screen uses this.
        }

        @JavascriptInterface
        public void stop() {
            main.post(service::stopAll);
        }
    }
}
