package io.github.jawedyari87_hue.chalkside;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.AudioPlaybackConfiguration;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import java.util.List;

/**
 * Runs a lesson: a foreground service (screen capture and microphone) that holds the
 * MediaProjection and the floating window. Started by MainActivity once you've agreed to share
 * your screen; ended from the floating bar, the notification or the app.
 */
public class TutorService extends Service {
    static final String ACTION_START = "io.github.jawedyari87_hue.chalkside.START";
    static final String ACTION_STOP = "io.github.jawedyari87_hue.chalkside.STOP";
    static final String ACTION_SETTINGS = "io.github.jawedyari87_hue.chalkside.SETTINGS";
    static final String EXTRA_CODE = "code";
    static final String EXTRA_DATA = "data";
    private static final String CHANNEL = "lesson";
    private static final int NOTIFICATION = 1;

    /** For the start screen: whether a lesson is running, and whether the tutor can see the screen. */
    static volatile boolean running, sharing;

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaProjection projection;
    private volatile ScreenCapture capture;
    private Overlay overlay;
    private MediaSession volumeKeys;
    private volatile PcLink pcLink;
    private boolean stopped;

    ScreenCapture capture() {
        return capture;
    }

    PcLink pcLink() {
        return pcLink;
    }

    /**
     * While the tutor is live its microphone puts Android in call mode, where the volume buttons
     * change the call volume. The tutor's voice comes out either as a call or as media, depending
     * on when the WebView opened its speaker, and it can move between them. A media session that
     * says it's playing, kept on whichever of the two the voice is using, sends the buttons there.
     */
    void setLessonLive(boolean live) {
        AudioManager am = getSystemService(AudioManager.class);
        if (live && volumeKeys == null) {
            MediaSession s = new MediaSession(this, "Chalkside");
            s.setPlaybackToLocal(attributes(voiceUsage));
            s.setPlaybackState(new PlaybackState.Builder().setState(PlaybackState.STATE_PLAYING, 0, 1f).build());
            s.setActive(true);
            volumeKeys = s;
            voiceWatch = new AudioManager.AudioPlaybackCallback() {
                @Override
                public void onPlaybackConfigChanged(List<AudioPlaybackConfiguration> configs) {
                    followVoice(configs);
                }
            };
            am.registerAudioPlaybackCallback(voiceWatch, main);
            followVoice(am.getActivePlaybackConfigurations());
            // By then the tutor has its speaker: if that volume is off, the tutor talks but nothing comes out.
            main.postDelayed(this::warnIfSilent, 5000);
        } else if (!live && volumeKeys != null) {
            am.unregisterAudioPlaybackCallback(voiceWatch);
            voiceWatch = null;
            volumeKeys.setActive(false);
            volumeKeys.release();
            volumeKeys = null;
        }
    }

    private AudioManager.AudioPlaybackCallback voiceWatch;
    private int voiceUsage = AudioAttributes.USAGE_MEDIA;

    // Other apps' sounds are media too, so a voice-call player means the tutor's voice is on the call path.
    private void followVoice(List<AudioPlaybackConfiguration> configs) {
        int usage = AudioAttributes.USAGE_MEDIA;
        for (AudioPlaybackConfiguration c : configs) {
            if (c.getAudioAttributes().getUsage() == AudioAttributes.USAGE_VOICE_COMMUNICATION) usage = AudioAttributes.USAGE_VOICE_COMMUNICATION;
        }
        if (usage == voiceUsage) return;
        voiceUsage = usage;
        if (volumeKeys != null) volumeKeys.setPlaybackToLocal(attributes(usage));
    }

    private static AudioAttributes attributes(int usage) {
        return new AudioAttributes.Builder().setUsage(usage).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
    }

    int voiceStream() {
        return voiceUsage == AudioAttributes.USAGE_VOICE_COMMUNICATION ? AudioManager.STREAM_VOICE_CALL : AudioManager.STREAM_MUSIC;
    }

    /** The tutor's volume for the bar's slider, as JSON {level, min, max}. */
    String voiceVolume() {
        AudioManager am = getSystemService(AudioManager.class);
        int s = voiceStream();
        return "{\"level\":" + am.getStreamVolume(s) + ",\"min\":" + am.getStreamMinVolume(s) + ",\"max\":" + am.getStreamMaxVolume(s) + "}";
    }

    void setVoiceVolume(int level) {
        AudioManager am = getSystemService(AudioManager.class);
        int s = voiceStream();
        am.setStreamVolume(s, Math.max(am.getStreamMinVolume(s), Math.min(am.getStreamMaxVolume(s), level)), 0);
    }

    private void warnIfSilent() {
        if (volumeKeys == null) return;
        if (getSystemService(AudioManager.class).getStreamVolume(voiceStream()) == 0) {
            toast("The tutor's volume is off. Tap the speaker button on the Chalkside bar to turn it up.");
        }
    }

    /** The bar's speaker button: Android's volume slider for the tutor's voice, a notch up if it was off. */
    void showVolume() {
        AudioManager am = getSystemService(AudioManager.class);
        int stream = voiceStream();
        boolean off = am.getStreamVolume(stream) <= am.getStreamMinVolume(stream) && stream == AudioManager.STREAM_MUSIC;
        am.adjustStreamVolume(stream, off ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_SAME, AudioManager.FLAG_SHOW_UI);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_START.equals(action)) {
            start(intent.getIntExtra(EXTRA_CODE, 0), parcelable(intent));
        } else if (ACTION_STOP.equals(action)) {
            requestStop();
        } else if (ACTION_SETTINGS.equals(action) && overlay != null) {
            overlay.send("settings");
        }
        if (!running) stopSelf();
        return START_NOT_STICKY;
    }

    @SuppressWarnings("deprecation")
    private static Intent parcelable(Intent intent) {
        return intent.getParcelableExtra(EXTRA_DATA);
    }

    private void start(int code, Intent data) {
        main.removeCallbacksAndMessages(null);
        createChannel();
        Notification n = notification("Starting the lesson…");
        // Android 14 needs the foreground service running, with these types, before the projection is made.
        try {
            startForeground(NOTIFICATION, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } catch (RuntimeException e) {
            Log.e(App.TAG, "Couldn't start with the microphone type", e);
            try {
                startForeground(NOTIFICATION, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } catch (RuntimeException e2) {
                Log.e(App.TAG, "Couldn't start the lesson", e2);
                toast("Android didn't let Chalkside start the lesson.");
                stopSelf();
                return;
            }
        }
        running = true;
        stopped = false;
        if (pcLink == null) {
            // Pictures of your PC's screen, if you've linked it (see PcLink).
            pcLink = new PcLink(this);
            pcLink.start();
        }
        if (code == Activity.RESULT_OK && data != null) startCapture(code, data);
        if (overlay == null) {
            overlay = new Overlay(this);
            overlay.show();
        } else if (capture != null) {
            // Sharing again during a lesson.
            overlay.captureChanged();
            overlay.send("screen-started");
        }
        updateNotification();
    }

    private void startCapture(int code, Intent data) {
        stopCapture(true);
        MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
        MediaProjection p;
        try {
            p = mpm.getMediaProjection(code, data);
        } catch (RuntimeException e) {
            Log.e(App.TAG, "Couldn't start screen sharing", e);
            p = null;
        }
        if (p == null) {
            toast("Couldn't start screen sharing. The tutor can still hear you.");
            return;
        }
        final MediaProjection proj = p;
        // Android 14 needs this before the virtual display is made.
        proj.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                main.post(() -> onProjectionStopped(proj));
            }
        }, main);
        projection = proj;
        ScreenCapture c = new ScreenCapture(this, proj);
        try {
            c.start();
        } catch (RuntimeException e) {
            Log.e(App.TAG, "Couldn't capture the screen", e);
            projection = null;
            proj.stop();
            return;
        }
        capture = c;
        sharing = true;
        if (overlay != null) overlay.captureChanged();
    }

    // Sharing ended from outside: the system's stop-sharing button, or the tablet locking.
    private void onProjectionStopped(MediaProjection p) {
        if (p != projection) return;
        projection = null;
        stopCapture(false);
        if (stopped) return;
        if (overlay != null) {
            overlay.clearMarks(true); // nothing can tell when they stop lining up any more
            overlay.send("screen-stopped");
        }
        updateNotification();
    }

    private void stopCapture(boolean stopProjection) {
        ScreenCapture c = capture;
        capture = null;
        sharing = false;
        if (c != null) c.stop();
        MediaProjection p = projection;
        projection = null;
        if (p != null && stopProjection) p.stop();
    }

    /** Lets the page end the lesson and save it first; stops anyway if it doesn't answer. */
    private void requestStop() {
        if (overlay == null) {
            stopAll();
            return;
        }
        overlay.send("stop");
        main.postDelayed(this::stopAll, 2500);
    }

    void stopAll() {
        if (stopped) return;
        stopped = true;
        running = false;
        setLessonLive(false);
        stopCapture(true);
        if (pcLink != null) pcLink.stop();
        pcLink = null;
        if (overlay != null) overlay.destroy();
        overlay = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    void openSettings() {
        try {
            startActivity(new Intent(this, SettingsActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (RuntimeException e) {
            Log.w(App.TAG, "Couldn't open settings", e);
            toast("Open the Chalkside app to change its settings.");
        }
    }

    @Override
    public void onDestroy() {
        stopAll();
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    // ---- notification ----

    private void createChannel() {
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Lesson", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shows while a lesson is running, with a button to end it.");
        getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }

    private void updateNotification() {
        if (!running) return;
        String text = sharing ? "The tutor can see your screen and hear you." : "The tutor can hear you, but screen sharing has stopped.";
        getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(text));
    }

    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, TutorService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Chalkside lesson")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .addAction(new Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_notification), "End lesson", stop).build());
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }

    private void toast(String text) {
        main.post(() -> Toast.makeText(this, text, Toast.LENGTH_LONG).show());
    }
}
