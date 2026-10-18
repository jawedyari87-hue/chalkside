package io.github.jawedyari87_hue.chalkside;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Pictures of the whole screen for the tutor: a mirror of the display, scaled so the long side
 * is at most 1024 px, turned into a JPEG at most once a second, and only when something on
 * screen has changed. The page fetches the newest one through the bridge.
 */
final class ScreenCapture {
    private static final int MAX_SIDE = 1024;
    private static final long INTERVAL_MS = 1000;
    private static final int JPEG_QUALITY = 80;
    // Change detection: the screen shrunk to a 32 x 20 grid of brightness values. A cell moving by
    // more than this (out of 255) counts as a change.
    private static final int SIG_W = 32, SIG_H = 20, SIG_CHANGE = 12;
    private static final int MASK_COLOUR = 0xFF213A33;

    private final MediaProjection projection;
    private final DisplayManager displays;
    private final HandlerThread thread = new HandlerThread("chalkside-capture");
    private Handler handler;
    private VirtualDisplay display;
    private ImageReader reader;

    // Used on the capture thread.
    private int frameW, frameH, dpi, screenW, screenH;
    private Image pending; // the newest image of the screen, not yet looked at
    private boolean scheduled;
    private long lastAt;
    private int[] lastSig;
    private Bitmap full;
    private final Paint maskPaint = new Paint();

    private volatile boolean active;
    private volatile Rect mask; // Chalkside's own floating window, in screen pixels
    private volatile int barTop, barBottom; // system bars, ignored when looking for changes
    private volatile Runnable onMoved; // most of the screen changed at once (a scroll, another app)
    // Share of the screen (outside Chalkside's window) that must change to count as moved.
    private static final float MOVED = 0.35f;

    private final Object lock = new Object();
    private int seq;
    private String json; // the newest picture, ready for the page

    ScreenCapture(Context ctx, MediaProjection projection) {
        this.projection = projection;
        this.displays = ctx.getSystemService(DisplayManager.class);
        maskPaint.setColor(MASK_COLOUR);
    }

    void start() {
        thread.start();
        handler = new Handler(thread.getLooper());
        measure();
        reader = newReader();
        display = projection.createVirtualDisplay("Chalkside", frameW, frameH, dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);
        displays.registerDisplayListener(rotation, handler);
    }

    void stop() {
        active = false;
        handler.post(() -> {
            displays.unregisterDisplayListener(rotation);
            if (display != null) display.release();
            display = null;
            dropPending();
            if (reader != null) reader.close();
            reader = null;
            if (full != null) full.recycle();
            full = null;
            thread.quitSafely();
        });
    }

    /** Whether the page wants pictures (a lesson is running and the screen isn't hidden). */
    void setActive(boolean on) {
        active = on;
        handler.post(this::schedule);
    }

    void setMask(Rect r) {
        mask = r;
    }

    void setSystemBars(int top, int bottom) {
        barTop = top;
        barBottom = bottom;
    }

    /** Runs on the capture thread when most of the screen changes at once, or the tablet turns. */
    void setOnScreenMoved(Runnable r) {
        onMoved = r;
    }

    /** The newest picture as JSON {seq, w, h, data}, or "" if there's none newer than {@code since} (-1: any). */
    String frame(int since) {
        synchronized (lock) {
            if (json == null || (since >= 0 && since >= seq)) return "";
            return json;
        }
    }

    // ---- capture thread ----

    private final DisplayManager.DisplayListener rotation = new DisplayManager.DisplayListener() {
        @Override
        public void onDisplayAdded(int id) {}

        @Override
        public void onDisplayRemoved(int id) {}

        @Override
        public void onDisplayChanged(int id) {
            if (id == Display.DEFAULT_DISPLAY) resize();
        }
    };

    /** Works out the mirror's size from the screen's. Returns whether it changed (the tablet turned). */
    @SuppressWarnings("deprecation") // getRealMetrics is still the simplest way to get the whole screen from a service
    private boolean measure() {
        DisplayMetrics m = new DisplayMetrics();
        displays.getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(m);
        float scale = Math.min(1f, MAX_SIDE / (float) Math.max(m.widthPixels, m.heightPixels));
        int w = Math.max(2, Math.round(m.widthPixels * scale)) & ~1;
        int h = Math.max(2, Math.round(m.heightPixels * scale)) & ~1;
        boolean changed = w != frameW || h != frameH;
        screenW = m.widthPixels;
        screenH = m.heightPixels;
        frameW = w;
        frameH = h;
        dpi = Math.max(1, Math.round(m.densityDpi * scale));
        return changed;
    }

    private ImageReader newReader() {
        ImageReader r = ImageReader.newInstance(frameW, frameH, PixelFormat.RGBA_8888, 4);
        r.setOnImageAvailableListener(this::onImage, handler);
        return r;
    }

    // A MediaProjection can only make one virtual display, so turning the tablet resizes it.
    private void resize() {
        if (display == null || !measure()) return;
        ImageReader old = reader;
        dropPending();
        reader = newReader();
        display.resize(frameW, frameH, dpi);
        display.setSurface(reader.getSurface());
        old.close();
        lastSig = null;
        Runnable moved = onMoved;
        if (moved != null) moved.run();
    }

    private void onImage(ImageReader r) {
        if (r != reader) return;
        Image img;
        try {
            img = r.acquireLatestImage();
        } catch (RuntimeException e) {
            return;
        }
        if (img == null) return;
        // Keep only the newest. It is kept even while no lesson is running, so a still screen
        // still has a picture to send when one starts.
        if (pending != null) pending.close();
        pending = img;
        schedule();
    }

    private void schedule() {
        if (!active || pending == null || scheduled) return;
        scheduled = true;
        long wait = lastAt + INTERVAL_MS - SystemClock.uptimeMillis();
        handler.postDelayed(this::process, Math.max(0, wait));
    }

    private void process() {
        scheduled = false;
        if (!active || pending == null) return;
        Image img = pending;
        pending = null;
        lastAt = SystemClock.uptimeMillis();
        Bitmap frame;
        try {
            frame = copy(img);
        } catch (RuntimeException e) {
            Log.w(App.TAG, "Couldn't read a picture of the screen", e);
            return;
        } finally {
            img.close();
        }
        int[] sig = signature(frame);
        if (lastSig != null) {
            int changed = 0, counted = 0;
            for (int i = 0; i < sig.length; i++) {
                if (sig[i] < 0 || lastSig[i] < 0) continue; // under Chalkside's own window
                counted++;
                if (Math.abs(sig[i] - lastSig[i]) > SIG_CHANGE) changed++;
            }
            if (changed == 0) return;
            Runnable moved = onMoved;
            if (moved != null && counted > 0 && changed > counted * MOVED) moved.run();
        }
        lastSig = sig;
        ByteArrayOutputStream out = new ByteArrayOutputStream(192 * 1024);
        frame.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
        String data = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        synchronized (lock) {
            seq++;
            json = "{\"seq\":" + seq + ",\"w\":" + frame.getWidth() + ",\"h\":" + frame.getHeight() + ",\"data\":\"" + data + "\"}";
        }
        if (frame != full) frame.recycle();
    }

    /** The image as a bitmap, with Chalkside's own window painted over: the tutor shouldn't read its own notes. */
    private Bitmap copy(Image img) {
        Image.Plane plane = img.getPlanes()[0];
        int w = img.getWidth(), h = img.getHeight();
        int stride = plane.getRowStride();
        int rowPixels = stride / plane.getPixelStride();
        if (full == null || full.getWidth() != rowPixels || full.getHeight() != h) {
            if (full != null) full.recycle();
            full = Bitmap.createBitmap(rowPixels, h, Bitmap.Config.ARGB_8888);
        }
        ByteBuffer buf = plane.getBuffer();
        buf.rewind();
        if (buf.remaining() >= stride * h) {
            full.copyPixelsFromBuffer(buf);
        } else {
            // Some devices leave the padding off the last row.
            ByteBuffer padded = ByteBuffer.allocate(stride * h);
            padded.put(buf);
            padded.rewind();
            full.copyPixelsFromBuffer(padded);
        }
        Rect m = mask;
        if (m != null && screenW > 0) {
            float s = w / (float) screenW;
            new Canvas(full).drawRect(m.left * s, m.top * s, m.right * s, m.bottom * s, maskPaint);
        }
        return rowPixels == w ? full : Bitmap.createBitmap(full, 0, 0, w, h);
    }

    private int[] signature(Bitmap frame) {
        int w = frame.getWidth(), h = frame.getHeight();
        float s = h / (float) Math.max(1, screenH);
        int top = Math.min(h / 4, Math.round(barTop * s));
        int bottom = Math.min(h / 4, Math.round(barBottom * s));
        Bitmap area = Bitmap.createBitmap(frame, 0, top, w, h - top - bottom);
        Bitmap small = Bitmap.createScaledBitmap(area, SIG_W, SIG_H, true);
        int[] px = new int[SIG_W * SIG_H];
        small.getPixels(px, 0, SIG_W, 0, 0, SIG_W, SIG_H);
        if (small != area) small.recycle();
        if (area != frame) area.recycle();
        for (int i = 0; i < px.length; i++) {
            int c = px[i];
            px[i] = (((c >> 16) & 0xFF) * 299 + ((c >> 8) & 0xFF) * 587 + (c & 0xFF) * 114) / 1000;
        }
        // Cells under Chalkside's own window are left out (-1): opening the panel isn't a change.
        Rect m = mask;
        if (m != null && screenW > 0) {
            float k = w / (float) screenW; // screen pixels to frame pixels
            float cellW = w / (float) SIG_W, cellH = (h - top - bottom) / (float) SIG_H;
            int c0 = Math.max(0, (int) Math.floor(m.left * k / cellW));
            int c1 = Math.min(SIG_W - 1, (int) Math.ceil(m.right * k / cellW) - 1);
            int r0 = Math.max(0, (int) Math.floor((m.top * k - top) / cellH));
            int r1 = Math.min(SIG_H - 1, (int) Math.ceil((m.bottom * k - top) / cellH) - 1);
            for (int r = r0; r <= r1; r++) {
                for (int c = c0; c <= c1; c++) px[r * SIG_W + c] = -1;
            }
        }
        return px;
    }

    private void dropPending() {
        if (pending != null) pending.close();
        pending = null;
    }
}
