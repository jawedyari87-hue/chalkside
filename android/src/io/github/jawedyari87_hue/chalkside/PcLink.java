package io.github.jawedyari87_hue.chalkside;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;

/**
 * Your PC, linked over the same Wi-Fi by the Chalkside PC link page (tutor/pclink/index.html).
 * The page sends pictures of the PC's screen, shows the tutor's board (so the tablet stays free
 * for writing) and passes on what you type there. During a lesson the tablet listens on port 8792
 * and answers only with the right code. The PC does the asking, so nothing on the PC has to accept
 * connections.
 */
final class PcLink {
    static final int PORT = 8792;
    private static final int MAX_BYTES = 4 * 1024 * 1024;
    private static final int MAX_SAY_BYTES = 8 * 1024;
    private static final long LINKED_MS = 20_000; // heard from the PC this recently: linked
    private static final long SHOWN_MS = 5_000; // the PC asked for the board this recently: it's showing it

    private static final long MAX_PIXELS = 12_000_000; // bigger than a 4K screen

    private final Context app;
    private final Consumer<String> onSay; // something typed or tapped on the PC (JSON), for the page
    private final long started = System.currentTimeMillis(); // tells the PC this is a new run of the app
    private volatile ServerSocket server;
    private volatile boolean stopped;
    private final Object lock = new Object();
    private int seq;
    private String json; // the newest picture, ready for the page
    private String board, live; // from the page: the board as HTML, and the captions and status (JSON)
    private int boardV, liveV;
    private volatile long heardAt, viewedAt;
    private final Map<String, int[]> failures = new HashMap<>(); // address -> {count, minute}

    PcLink(Context ctx, Consumer<String> onSay) {
        app = ctx.getApplicationContext();
        this.onSay = onSay;
    }

    /** The code the PC page must send: made once, kept until you ask for a new one. */
    static String code(Context ctx) {
        String c = App.prefs(ctx).getString("pcCode", null);
        if (c == null) c = newCode(ctx);
        return c;
    }

    static String newCode(Context ctx) {
        String c = String.format(Locale.ROOT, "%06d", new SecureRandom().nextInt(1_000_000));
        App.prefs(ctx).edit().putString("pcCode", c).apply();
        return c;
    }

    /** The tablet's address on the Wi-Fi, for the PC page, or null when it isn't on a network. */
    static String address(Context ctx) {
        ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
        Network net = cm.getActiveNetwork();
        LinkProperties lp = net == null ? null : cm.getLinkProperties(net);
        if (lp == null) return null;
        for (LinkAddress la : lp.getLinkAddresses()) {
            InetAddress a = la.getAddress();
            if (a instanceof Inet4Address && !a.isLoopbackAddress()) return a.getHostAddress();
        }
        return null;
    }

    void start() {
        Thread t = new Thread(this::serve, "chalkside-pclink");
        t.setDaemon(true);
        t.start();
    }

    void stop() {
        stopped = true;
        ServerSocket s = server;
        server = null;
        try {
            if (s != null) s.close();
        } catch (IOException ignored) {
            // closing anyway
        }
    }

    boolean linked() {
        return SystemClock.uptimeMillis() - heardAt < LINKED_MS;
    }

    /** The newest PC picture as JSON {seq, w, h, data}, or "" if there's none newer than {@code since}. */
    String frame(int since) {
        synchronized (lock) {
            if (json == null || (since >= 0 && since >= seq)) return "";
            return json;
        }
    }

    /** The board for the PC to show: JSON from the page, passed on as it is. */
    void setBoard(String boardJson) {
        synchronized (lock) {
            board = boardJson;
            boardV++;
        }
    }

    /** What the tutor is saying and doing now: JSON from the page, passed on as it is. */
    void setLive(String liveJson) {
        synchronized (lock) {
            live = liveJson;
            liveV++;
        }
    }

    /** Whether the PC link page is showing the board. */
    boolean boardShown() {
        return SystemClock.uptimeMillis() - viewedAt < SHOWN_MS;
    }

    // The board and the live part, each only if it has changed since the version the PC has.
    private String boardSince(int b, int l) {
        synchronized (lock) {
            return "{\"run\":" + started + ",\"b\":" + boardV + ",\"l\":" + liveV
                    + ",\"board\":" + (board != null && b != boardV ? board : "null")
                    + ",\"live\":" + (live != null && l != liveV ? live : "null") + "}";
        }
    }

    // A number from the query string ("/board?b=3&l=7"), or -1.
    private static int query(String path, String name) {
        int q = path.indexOf('?');
        if (q < 0) return -1;
        for (String pair : path.substring(q + 1).split("&")) {
            if (pair.startsWith(name + "=")) {
                try {
                    return Integer.parseInt(pair.substring(name.length() + 1));
                } catch (NumberFormatException e) {
                    return -1;
                }
            }
        }
        return -1;
    }

    private void serve() {
        try (ServerSocket s = new ServerSocket()) {
            s.setReuseAddress(true);
            s.bind(new InetSocketAddress(PORT));
            server = s;
            if (stopped) return; // the lesson ended while this was starting
            while (server == s) {
                try (Socket c = s.accept()) {
                    c.setSoTimeout(8000);
                    handle(c);
                } catch (IOException e) {
                    if (server != s) break;
                    Log.w(App.TAG, "PC link request failed: " + e.getMessage());
                } catch (RuntimeException | OutOfMemoryError e) {
                    Log.w(App.TAG, "PC link couldn't use a request", e); // a bad picture mustn't end the lesson
                }
            }
        } catch (IOException e) {
            Log.w(App.TAG, "PC link couldn't listen on port " + PORT, e);
        }
    }

    // A tiny HTTP/1.1 server: OPTIONS (the browser's permission check), GET /hello, POST /frame,
    // GET /board and POST /say.
    private void handle(Socket c) throws IOException {
        InputStream in = c.getInputStream();
        OutputStream out = c.getOutputStream();
        String request = line(in);
        if (request == null) return;
        Map<String, String> headers = new HashMap<>();
        for (String h; (h = line(in)) != null && !h.isEmpty(); ) {
            int i = h.indexOf(':');
            if (i > 0) headers.put(h.substring(0, i).trim().toLowerCase(Locale.ROOT), h.substring(i + 1).trim());
        }
        String[] parts = request.split(" ");
        String method = parts[0], path = parts.length > 1 ? parts[1] : "/";
        if (method.equals("OPTIONS")) {
            reply(out, 204, "", null);
            return;
        }
        int length;
        try {
            length = Math.max(0, Integer.parseInt(headers.getOrDefault("content-length", "0")));
        } catch (NumberFormatException e) {
            length = 0;
        }
        if (length > MAX_BYTES) {
            reply(out, 413, "text/plain", "Picture too big.");
            return;
        }
        // Read any picture first, even one we'll turn down: closing a connection with unread data
        // resets it, and the browser would see a network error instead of the answer.
        byte[] body = new byte[length];
        for (int got = 0; got < length; ) {
            int n = in.read(body, got, length - got);
            if (n < 0) throw new IOException("picture cut short");
            got += n;
        }
        String who = c.getInetAddress().getHostAddress();
        if (tooManyFailures(who)) {
            reply(out, 429, "text/plain", "Too many wrong codes. Wait a minute.");
            return;
        }
        if (!code(app).equals(headers.get("x-chalkside-code"))) { // read each time: "New code" works mid-lesson
            failed(who);
            reply(out, 403, "text/plain", "Wrong code. It's on the Chalkside app's start screen.");
            return;
        }
        if (method.equals("GET") && path.startsWith("/hello")) {
            heardAt = SystemClock.uptimeMillis();
            int have;
            synchronized (lock) {
                have = seq;
            }
            reply(out, 200, "application/json", "{\"app\":\"Chalkside\",\"seq\":" + have + "}");
        } else if (method.equals("POST") && path.startsWith("/frame")) {
            if (body.length == 0) {
                reply(out, 400, "text/plain", "No picture.");
                return;
            }
            heardAt = SystemClock.uptimeMillis();
            reply(out, store(body) ? 204 : 400, "text/plain", "");
        } else if (method.equals("GET") && path.startsWith("/board")) {
            viewedAt = SystemClock.uptimeMillis();
            reply(out, 200, "application/json; charset=utf-8", boardSince(query(path, "b"), query(path, "l")));
        } else if (method.equals("POST") && path.startsWith("/say")) {
            if (body.length == 0 || body.length > MAX_SAY_BYTES) {
                reply(out, 400, "text/plain", "Nothing to say, or too much.");
                return;
            }
            onSay.accept(new String(body, StandardCharsets.UTF_8));
            reply(out, 204, "text/plain", "");
        } else {
            reply(out, 404, "text/plain", "Not here.");
        }
    }

    // The picture with a "PC screen" strip on top, so the tutor can tell it from the tablet.
    private boolean store(byte[] jpeg) {
        BitmapFactory.Options size = new BitmapFactory.Options();
        size.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, size);
        if (size.outWidth <= 0 || size.outHeight <= 0 || (long) size.outWidth * size.outHeight > MAX_PIXELS) return false;
        Bitmap pic = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
        if (pic == null) return false;
        int strip = Math.max(28, pic.getWidth() / 40);
        Bitmap out = Bitmap.createBitmap(pic.getWidth(), pic.getHeight() + strip, Bitmap.Config.ARGB_8888);
        Canvas g = new Canvas(out);
        g.drawColor(Color.rgb(33, 58, 51));
        g.drawBitmap(pic, 0, strip, null);
        Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
        text.setColor(Color.WHITE);
        text.setTypeface(Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD));
        text.setTextSize(strip * 0.62f);
        g.drawText("PC screen", strip * 0.5f, strip * 0.72f, text);
        ByteArrayOutputStream buf = new ByteArrayOutputStream(jpeg.length + 32 * 1024);
        out.compress(Bitmap.CompressFormat.JPEG, 82, buf);
        String data = Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP);
        synchronized (lock) {
            seq++;
            json = "{\"seq\":" + seq + ",\"w\":" + out.getWidth() + ",\"h\":" + out.getHeight() + ",\"data\":\"" + data + "\"}";
        }
        pic.recycle();
        out.recycle();
        return true;
    }

    private void reply(OutputStream out, int status, String type, String body) throws IOException {
        byte[] bytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        StringBuilder h = new StringBuilder("HTTP/1.1 ").append(status).append(status < 300 ? " OK" : " Error").append("\r\n")
                .append("Access-Control-Allow-Origin: *\r\n")
                .append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
                .append("Access-Control-Allow-Headers: Content-Type, X-Chalkside-Code\r\n")
                .append("Access-Control-Allow-Private-Network: true\r\n")
                .append("Access-Control-Max-Age: 600\r\n")
                .append("Connection: close\r\n")
                .append("Content-Length: ").append(bytes.length).append("\r\n");
        if (type != null && !type.isEmpty()) h.append("Content-Type: ").append(type).append("\r\n");
        out.write(h.append("\r\n").toString().getBytes(StandardCharsets.US_ASCII));
        out.write(bytes);
        out.flush();
    }

    private static String line(InputStream in) throws IOException {
        StringBuilder s = new StringBuilder();
        for (int b; (b = in.read()) != -1; ) {
            if (b == '\n') return s.toString().replace("\r", "");
            if (s.length() > 8192) throw new IOException("header too long");
            s.append((char) b);
        }
        return s.length() == 0 ? null : s.toString();
    }

    // At most 10 wrong codes a minute from any one address.
    private boolean tooManyFailures(String who) {
        int[] f = failures.get(who);
        long minute = SystemClock.uptimeMillis() / 60_000;
        return f != null && f[1] == minute && f[0] >= 10;
    }

    private void failed(String who) {
        int minute = (int) (SystemClock.uptimeMillis() / 60_000);
        int[] f = failures.get(who);
        if (f == null || f[1] != minute) failures.put(who, new int[] {1, minute});
        else f[0]++;
    }
}
