package io.github.jawedyari87_hue.chalkside;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.text.TextPaint;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.View;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The tutor's pen marks, drawn over the whole screen like the web app's marks on the page:
 * a red ring round a mistake, a green tick by a right line, an amber wave under something to
 * check, a blue bracket by a note, each with a short label.
 */
final class MarksView extends View {
    private static final int RED = 0xFFE0352B, GREEN = 0xFF1E9E4A, AMBER = 0xFFE08600, BLUE = 0xFF2F6FDE;

    private static final class Mark {
        final RectF box;
        final String verdict;
        final String label;

        Mark(RectF box, String verdict, String label) {
            this.box = box;
            this.verdict = verdict;
            this.label = label;
        }
    }

    private final List<Mark> marks = new ArrayList<>();
    private final float dp;
    private final Paint pen = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint halo = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ink = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint inkHalo = new Paint(Paint.ANTI_ALIAS_FLAG);

    MarksView(Context ctx) {
        super(ctx);
        dp = ctx.getResources().getDisplayMetrics().density;
        for (Paint p : new Paint[] {pen, halo}) {
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeCap(Paint.Cap.ROUND);
            p.setStrokeJoin(Paint.Join.ROUND);
        }
        pen.setStrokeWidth(3.5f * dp);
        // A soft white edge under every stroke and letter, so marks show on dark screens too.
        halo.setStrokeWidth(8f * dp);
        halo.setColor(Color.argb(200, 255, 255, 255));
        Typeface hand = Typeface.create("sans-serif-medium", Typeface.BOLD);
        float size = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 17, ctx.getResources().getDisplayMetrics());
        ink.setTypeface(hand);
        ink.setTextSize(size);
        inkHalo.setTypeface(hand);
        inkHalo.setTextSize(size);
        inkHalo.setStyle(Paint.Style.STROKE);
        inkHalo.setStrokeWidth(5f * dp);
        inkHalo.setStrokeJoin(Paint.Join.ROUND);
        inkHalo.setColor(Color.argb(220, 255, 255, 255));
    }

    /**
     * Marks from the page as JSON [{box: [ymin, xmin, ymax, xmax] on a 0-1000 grid over the whole
     * screen, verdict, label}]. Returns how many could be drawn.
     */
    int setMarks(String json, int screenW, int screenH) {
        marks.clear();
        try {
            JSONArray list = new JSONArray(json);
            for (int i = 0; i < list.length() && marks.size() < 12; i++) {
                JSONObject m = list.getJSONObject(i);
                JSONArray b = m.getJSONArray("box");
                if (b.length() != 4) continue;
                double[] v = {b.getDouble(0), b.getDouble(1), b.getDouble(2), b.getDouble(3)};
                // Boxes given on a 0-1 scale are accepted too, as in the web app.
                boolean unit = v[0] <= 1 && v[1] <= 1 && v[2] <= 1 && v[3] <= 1 && (v[2] > 0 || v[3] > 0);
                float ymin = clamp1000(v[0], unit), xmin = clamp1000(v[1], unit);
                float ymax = clamp1000(v[2], unit), xmax = clamp1000(v[3], unit);
                RectF box = new RectF(Math.min(xmin, xmax) / 1000f * screenW, Math.min(ymin, ymax) / 1000f * screenH,
                        Math.max(xmin, xmax) / 1000f * screenW, Math.max(ymin, ymax) / 1000f * screenH);
                // Very small boxes still get a visible mark.
                float min = 14 * dp;
                if (box.width() < min) box.inset((box.width() - min) / 2, 0);
                if (box.height() < min) box.inset(0, (box.height() - min) / 2);
                marks.add(new Mark(box, m.optString("verdict", "note"), plain(m.optString("label", ""))));
            }
        } catch (Exception e) {
            marks.clear();
        }
        setAlpha(0f);
        animate().alpha(1f).setDuration(250).start();
        invalidate();
        return marks.size();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        for (Mark m : marks) draw(canvas, m);
    }

    private void draw(Canvas c, Mark m) {
        RectF b = m.box;
        int colour;
        Path p = new Path();
        float labelX, labelY;
        switch (m.verdict) {
            case "mistake": {
                colour = RED;
                // A hand-drawn ring that overshoots where it started.
                float rx = b.width() / 2 + Math.max(8 * dp, b.width() * 0.08f);
                float ry = b.height() / 2 + Math.max(8 * dp, b.height() * 0.25f);
                for (int i = 0; i <= 44; i++) {
                    double t = Math.toRadians(200 + i * 9);
                    float wobble = 1 + 0.03f * (float) Math.sin(i * 0.9);
                    float x = b.centerX() + (float) Math.cos(t) * rx * wobble;
                    float y = b.centerY() + (float) Math.sin(t) * ry * wobble;
                    if (i == 0) p.moveTo(x, y);
                    else p.lineTo(x, y);
                }
                labelX = b.centerX() + rx + 10 * dp;
                labelY = b.centerY() - ry * 0.4f;
                break;
            }
            case "correct": {
                colour = GREEN;
                float s = Math.max(24 * dp, Math.min(52 * dp, b.height() * 0.9f));
                float x0 = b.right + 8 * dp;
                if (x0 + s > getWidth()) x0 = b.right - s;
                float y0 = b.centerY();
                p.moveTo(x0, y0);
                p.lineTo(x0 + s * 0.35f, y0 + s * 0.4f);
                p.lineTo(x0 + s, y0 - s * 0.6f);
                labelX = x0 + s + 10 * dp;
                labelY = y0;
                break;
            }
            case "check": {
                colour = AMBER;
                float y = b.bottom + 6 * dp, step = 6 * dp;
                p.moveTo(b.left, y);
                boolean up = true;
                for (float x = b.left + step; x <= b.right; x += step, up = !up) p.quadTo(x - step / 2, y + (up ? -4 : 4) * dp, x, y);
                labelX = b.right + 10 * dp;
                labelY = b.centerY();
                break;
            }
            default: {
                colour = BLUE;
                float x = b.left - 12 * dp;
                p.moveTo(x + 7 * dp, b.top);
                p.lineTo(x, b.top);
                p.lineTo(x, b.bottom);
                p.lineTo(x + 7 * dp, b.bottom);
                labelX = b.right + 10 * dp;
                labelY = b.centerY();
                break;
            }
        }
        c.drawPath(p, halo);
        pen.setColor(colour);
        c.drawPath(p, pen);
        if (m.label.isEmpty()) return;

        // The label to the right of the mark, or underneath if there's no room.
        float max = Math.min(360 * dp, getWidth() * 0.4f);
        String text = TextUtils.ellipsize(m.label, new TextPaint(ink), max, TextUtils.TruncateAt.END).toString();
        float w = ink.measureText(text);
        if (labelX + w > getWidth() - 8 * dp) {
            labelX = Math.max(8 * dp, Math.min(b.left, getWidth() - 8 * dp - w));
            labelY = b.bottom + 14 * dp + ink.getTextSize() * 0.6f;
        }
        float baseline = labelY + ink.getTextSize() * 0.35f;
        c.drawText(text, labelX, baseline, inkHalo);
        ink.setColor(colour);
        c.drawText(text, labelX, baseline, ink);
    }

    private static float clamp1000(double v, boolean unit) {
        if (unit) v *= 1000;
        return (float) Math.max(0, Math.min(1000, v));
    }

    // Labels may hold a little LaTeX ("sign error: $-2x$"); show it as plain text.
    private static String plain(String s) {
        String[][] symbols = {
            {"\\times", "×"}, {"\\cdot", "·"}, {"\\leq", "≤"}, {"\\geq", "≥"}, {"\\le", "≤"}, {"\\ge", "≥"},
            {"\\neq", "≠"}, {"\\ne", "≠"}, {"\\pm", "±"}, {"\\to", "→"}, {"\\infty", "∞"}, {"\\pi", "π"},
            {"\\lambda", "λ"}, {"\\theta", "θ"}, {"\\alpha", "α"}, {"\\beta", "β"}, {"\\sum", "Σ"}, {"\\sqrt", "√"},
        };
        String out = s.replace("$", "");
        for (String[] pair : symbols) out = out.replace(pair[0], pair[1]);
        out = out.replaceAll("\\\\[a-zA-Z]+", "").replace("{", "").replace("}", "").replaceAll("\\s+", " ").trim();
        return out.length() > 80 ? out.substring(0, 80) : out;
    }
}
