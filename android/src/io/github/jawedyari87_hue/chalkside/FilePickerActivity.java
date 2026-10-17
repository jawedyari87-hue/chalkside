package io.github.jawedyari87_hue.chalkside;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;

import java.util.ArrayList;
import java.util.List;

/**
 * Android's file picker for the floating window, which can't open one itself (only an activity
 * can). Invisible: it opens the picker, hands the chosen files to the page and closes.
 */
public class FilePickerActivity extends Activity {
    private static final int REQ_PICK = 1;
    // Read access to a chosen file is kept this long, so the page can finish reading it.
    private static final long KEEP_ACCESS_MS = 5 * 60 * 1000;

    private static ValueCallback<Uri[]> pending;
    private static String[] pendingTypes;
    private static boolean pendingMultiple;
    private static Runnable pendingDone;

    /** Open the picker for a page's file input. {@code done} runs once the page has its answer. */
    static void open(Context ctx, ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params, Runnable done) {
        if (pending != null) pending.onReceiveValue(null);
        pending = callback;
        pendingTypes = mimeTypes(params.getAcceptTypes());
        pendingMultiple = params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        pendingDone = done;
        ctx.startActivity(new Intent(ctx, FilePickerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (pending == null) {
            finish();
            return;
        }
        if (state != null) return; // the picker is already open
        // OPEN_DOCUMENT, so read access can outlive this activity: the page reads the file after it closes.
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType(pendingTypes.length == 1 ? pendingTypes[0] : "*/*");
        if (pendingTypes.length > 1) pick.putExtra(Intent.EXTRA_MIME_TYPES, pendingTypes);
        if (pendingMultiple) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            startActivityForResult(pick, REQ_PICK);
        } catch (ActivityNotFoundException e) {
            Log.w(App.TAG, "No file picker", e);
            deliver(null);
        }
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req == REQ_PICK) deliver(result == RESULT_OK ? chosen(data) : null);
    }

    private void deliver(Uri[] uris) {
        if (uris != null) {
            for (Uri u : uris) keepAccess(u);
        }
        ValueCallback<Uri[]> cb = pending;
        Runnable done = pendingDone;
        pending = null;
        pendingDone = null;
        if (cb != null) cb.onReceiveValue(uris);
        if (done != null) done.run();
        finish();
    }

    // A picked file's access normally ends with this activity; hold it for a few minutes instead.
    private void keepAccess(Uri uri) {
        final Context app = getApplicationContext();
        try {
            app.getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try {
                    app.getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (SecurityException ignored) {
                    // already gone
                }
            }, KEEP_ACCESS_MS);
        } catch (SecurityException e) {
            Log.w(App.TAG, "Couldn't keep access to " + uri, e);
        }
    }

    private static Uri[] chosen(Intent data) {
        if (data == null) return null;
        ClipData clip = data.getClipData();
        if (clip != null && clip.getItemCount() > 0) {
            Uri[] out = new Uri[clip.getItemCount()];
            for (int i = 0; i < out.length; i++) out[i] = clip.getItemAt(i).getUri();
            return out;
        }
        Uri u = data.getData();
        return u == null ? null : new Uri[] {u};
    }

    // The input's accept list ("image/*,.pdf") as MIME types for the picker.
    private static String[] mimeTypes(String[] accept) {
        List<String> out = new ArrayList<>();
        if (accept != null) {
            for (String a : accept) {
                for (String t : a.split(",")) {
                    t = t.trim().toLowerCase(java.util.Locale.ROOT);
                    if (t.equals(".pdf")) t = "application/pdf";
                    if (t.contains("/") && !out.contains(t)) out.add(t);
                }
            }
        }
        if (out.isEmpty()) out.add("*/*");
        return out.toArray(new String[0]);
    }
}
