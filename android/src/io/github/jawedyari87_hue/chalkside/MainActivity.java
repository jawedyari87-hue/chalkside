package io.github.jawedyari87_hue.chalkside;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.RippleDrawable;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * The start screen: what the app does, the permissions it needs, and Start lesson. Starting asks
 * Android to share the screen, then hands over to TutorService and gets out of the way.
 */
public class MainActivity extends Activity {
    private static final int REQ_CAPTURE = 1;
    private static final int REQ_PERMISSIONS = 2;

    private static final int SLATE = 0xFF213A33;
    private static final int CHALK = 0xFFEDF1E7;
    private static final int CHALK_DIM = 0xFFA8B8AE;
    private static final int YELLOW = 0xFFF2D479;
    private static final int GREEN = 0xFFA8DBA0;
    private static final int ACCENT = 0xFF5FB39A;
    private static final int ACCENT_INK = 0xFF0D1A15;
    private static final int DANGER = 0xFFE0705F;
    private static final int LINE = 0x29EDF1E7;

    private final Handler main = new Handler(Looper.getMainLooper());
    private LinearLayout checklist;
    private TextView startBtn, reshareBtn, note;
    /** Set while working through Start lesson, so each permission screen carries on to the next step. */
    private boolean starting;
    private String noteText = "";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setBackgroundDrawable(new ColorDrawable(SLATE));
        setContentView(buildUi());
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        setContentView(buildUi());
        refresh();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
        // Back from a settings screen in the middle of Start lesson: carry on if that step is done.
        if (starting) main.post(this::continueStart);
    }

    // ---- starting a lesson ----

    private void onStartPressed() {
        if (TutorService.running) {
            startService(new Intent(this, TutorService.class).setAction(TutorService.ACTION_STOP));
            setNote("Ending the lesson…");
            main.postDelayed(this::refresh, 800);
            return;
        }
        starting = true;
        continueStart();
    }

    private void continueStart() {
        if (!starting) return;
        if (!hasMic()) {
            requestPermissions(missingPermissions(), REQ_PERMISSIONS);
            return;
        }
        if (!Settings.canDrawOverlays(this)) {
            if (askedFor("overlay")) {
                starting = false;
                setNote("Chalkside needs to show over other apps for the floating bar. Turn it on above, then start again.");
                return;
            }
            openOverlaySettings();
            return;
        }
        if (!App.hasKey(this)) {
            if (askedFor("key")) {
                starting = false;
                setNote("Add your Gemini API key first.");
                return;
            }
            openSettings();
            return;
        }
        starting = false;
        asked.clear();
        requestCapture();
    }

    // Each permission screen is opened once per press of Start lesson, so backing out of it stops there.
    private final List<String> asked = new ArrayList<>();

    private boolean askedFor(String what) {
        if (asked.contains(what)) return true;
        asked.add(what);
        return false;
    }

    private void requestCapture() {
        MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
        // Android 14 and later: only offer "entire screen", since the tutor should follow you between apps.
        Intent consent = Build.VERSION.SDK_INT >= 34
                ? mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                : mpm.createScreenCaptureIntent();
        startActivityForResult(consent, REQ_CAPTURE);
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req != REQ_CAPTURE) return;
        if (result != RESULT_OK || data == null) {
            setNote("The tutor needs to see your screen for a lesson. Tap Start lesson to try again.");
            return;
        }
        Intent start = new Intent(this, TutorService.class)
                .setAction(TutorService.ACTION_START)
                .putExtra(TutorService.EXTRA_CODE, result)
                .putExtra(TutorService.EXTRA_DATA, data);
        startForegroundService(start);
        setNote("");
        // Back to whatever you were doing, with the tutor floating on top.
        moveTaskToBack(true);
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(req, permissions, results);
        refresh();
        if (!starting) return;
        if (hasMic()) {
            continueStart();
        } else {
            starting = false;
            setNote("The tutor needs the microphone to hear you. If Android doesn't ask any more, allow it in Settings > Apps > Chalkside > Permissions.");
        }
    }

    private String[] missingPermissions() {
        List<String> out = new ArrayList<>();
        if (!hasMic()) out.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33 && !hasNotifications()) out.add(Manifest.permission.POST_NOTIFICATIONS);
        return out.toArray(new String[0]);
    }

    private boolean hasMic() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasNotifications() {
        return Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private void openOverlaySettings() {
        startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
    }

    private void openSettings() {
        startActivity(new Intent(this, SettingsActivity.class));
    }

    // ---- the screen ----

    private void setNote(String text) {
        noteText = text;
        if (note != null) {
            note.setText(text);
            note.setVisibility(text.isEmpty() ? View.GONE : View.VISIBLE);
        }
    }

    private void refresh() {
        if (checklist == null) return;
        checklist.removeAllViews();
        checklist.addView(row("Microphone", "So the tutor can hear you.", hasMic(), "Allow",
                () -> requestPermissions(missingPermissions(), REQ_PERMISSIONS)));
        checklist.addView(row("Show over other apps", "For the floating bar and the tutor's notes.", Settings.canDrawOverlays(this),
                "Turn on", this::openOverlaySettings));
        if (Build.VERSION.SDK_INT >= 33) {
            checklist.addView(row("Notifications", "Shows while a lesson runs, with a button to end it. Optional.", hasNotifications(),
                    "Allow", () -> requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_PERMISSIONS)));
        }
        checklist.addView(row("Gemini API key", "Your free key from aistudio.google.com/apikey.", App.hasKey(this),
                "Add key", this::openSettings));

        boolean running = TutorService.running;
        startBtn.setText(running ? "End lesson" : "Start lesson");
        startBtn.setBackground(pill(running ? DANGER : ACCENT, 28));
        reshareBtn.setVisibility(running && !TutorService.sharing ? View.VISIBLE : View.GONE);
        if (running && noteText.isEmpty()) {
            note.setText(TutorService.sharing
                    ? "A lesson is running. Talk to the tutor using the floating bar over your other apps."
                    : "A lesson is running, but screen sharing has stopped. Share your screen again so the tutor can see it.");
            note.setVisibility(View.VISIBLE);
        } else {
            setNote(noteText);
        }
    }

    private View buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        });

        Column col = new Column(this, dp(580));
        col.setPadding(dp(24), dp(32), dp(24), dp(32));
        FrameLayout.LayoutParams colLp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        colLp.gravity = Gravity.CENTER_HORIZONTAL;
        scroll.addView(col, colLp);

        LinearLayout brand = new LinearLayout(this);
        brand.setGravity(Gravity.CENTER_VERTICAL);
        ImageView icon = new ImageView(this);
        icon.setImageResource(R.mipmap.ic_launcher);
        brand.addView(icon, new LinearLayout.LayoutParams(dp(56), dp(56)));
        TextView name = text("Chalkside", 30, CHALK, true);
        name.setPadding(dp(12), 0, 0, 0);
        brand.addView(name);
        col.addView(brand);

        TextView tag = text("A maths tutor that can see your whole screen", 17, YELLOW, false);
        tag.setPadding(0, dp(14), 0, 0);
        col.addView(tag);
        TextView about = text("Start a lesson, then open your lecture slides, Samsung Notes or a problem sheet. "
                + "Ask the tutor about whatever is on screen. It answers out loud and writes the maths in a floating "
                + "panel, so you can read it back.", 16, CHALK, false);
        about.setPadding(0, dp(8), 0, dp(20));
        about.setLineSpacing(0, 1.2f);
        col.addView(about);

        col.addView(heading("Before your first lesson"));
        checklist = new LinearLayout(this);
        checklist.setOrientation(LinearLayout.VERTICAL);
        col.addView(checklist);

        startBtn = button("Start lesson", ACCENT, ACCENT_INK, 18);
        startBtn.setOnClickListener(v -> onStartPressed());
        LinearLayout.LayoutParams startLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(58));
        startLp.topMargin = dp(28);
        col.addView(startBtn, startLp);

        reshareBtn = button("Share my screen again", 0, CHALK, 16);
        reshareBtn.setBackground(outline());
        reshareBtn.setOnClickListener(v -> requestCapture());
        LinearLayout.LayoutParams reLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50));
        reLp.topMargin = dp(12);
        col.addView(reshareBtn, reLp);

        note = text("", 15, CHALK, false);
        note.setPadding(0, dp(14), 0, 0);
        note.setLineSpacing(0, 1.15f);
        col.addView(note);

        TextView tips = text("When Android asks, choose to share your entire screen. Drag the floating bar to move it, "
                + "and tap its expand button to read everything the tutor has said and written.", 14, CHALK_DIM, false);
        tips.setPadding(0, dp(22), 0, 0);
        tips.setLineSpacing(0, 1.15f);
        col.addView(tips);

        TextView settings = button("Tutor settings: voice, model, how much help", 0, CHALK, 15);
        settings.setBackground(outline());
        settings.setOnClickListener(v -> openSettings());
        LinearLayout.LayoutParams setLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50));
        setLp.topMargin = dp(22);
        col.addView(settings, setLp);

        if (!App.base().equals(BuildInfo.LIVE_URL)) {
            TextView dev = text("Test build: " + App.base(), 13, CHALK_DIM, false);
            dev.setPadding(0, dp(18), 0, 0);
            col.addView(dev);
        }
        return scroll;
    }

    private View row(String title, String detail, boolean done, String action, Runnable onAction) {
        LinearLayout r = new LinearLayout(this);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(0, dp(12), 0, dp(12));
        r.setBackground(bottomLine());

        LinearLayout words = new LinearLayout(this);
        words.setOrientation(LinearLayout.VERTICAL);
        words.addView(text(title, 17, CHALK, true));
        TextView d = text(detail, 14, CHALK_DIM, false);
        d.setPadding(0, dp(2), dp(12), 0);
        words.addView(d);
        r.addView(words, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if (done) {
            TextView ok = text("✓ Done", 15, GREEN, true);
            r.addView(ok);
        } else {
            TextView b = button(action, 0, CHALK, 15);
            b.setBackground(outline());
            b.setPadding(dp(18), 0, dp(18), 0);
            b.setOnClickListener(v -> onAction.run());
            r.addView(b, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)));
        }
        return r;
    }

    private Drawable bottomLine() {
        GradientDrawable line = new GradientDrawable();
        line.setColor(LINE);
        LayerDrawable layer = new LayerDrawable(new Drawable[] {line});
        layer.setLayerGravity(0, Gravity.BOTTOM | Gravity.FILL_HORIZONTAL);
        layer.setLayerHeight(0, Math.max(1, dp(1)));
        return layer;
    }

    private TextView heading(String s) {
        TextView t = text(s.toUpperCase(java.util.Locale.ROOT), 13, CHALK_DIM, true);
        t.setLetterSpacing(0.08f);
        t.setPadding(0, 0, 0, dp(4));
        return t;
    }

    private TextView text(String s, int sp, int colour, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(colour);
        if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD));
        return t;
    }

    private TextView button(String s, int fill, int ink, int sp) {
        TextView b = text(s, sp, ink, true);
        b.setGravity(Gravity.CENTER);
        b.setClickable(true);
        b.setFocusable(true);
        if (fill != 0) b.setBackground(pill(fill, 26));
        return b;
    }

    private RippleDrawable pill(int fill, int radiusDp) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        shape.setCornerRadius(dp(radiusDp));
        return new RippleDrawable(ColorStateList.valueOf(0x33FFFFFF), shape, null);
    }

    private RippleDrawable outline() {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(0);
        shape.setStroke(dp(1), 0x66EDF1E7);
        shape.setCornerRadius(dp(24));
        GradientDrawable mask = new GradientDrawable();
        mask.setColor(0xFFFFFFFF);
        mask.setCornerRadius(dp(24));
        return new RippleDrawable(ColorStateList.valueOf(0x33FFFFFF), shape, mask);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** A column no wider than {@code max}, so the screen reads well on a big tablet. */
    private static final class Column extends LinearLayout {
        private final int max;

        Column(Context c, int max) {
            super(c);
            this.max = max;
            setOrientation(VERTICAL);
        }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            if (MeasureSpec.getSize(widthSpec) > max) widthSpec = MeasureSpec.makeMeasureSpec(max, MeasureSpec.EXACTLY);
            super.onMeasure(widthSpec, heightSpec);
        }
    }
}
