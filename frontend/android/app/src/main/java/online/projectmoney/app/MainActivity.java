package online.projectmoney.app;

import android.os.Bundle;
import android.view.WindowManager;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

/**
 * At targetSdk 36 (Android 15/16) edge-to-edge is enforced: the window draws behind the status bar,
 * the navigation bar and the display cutout, and the old opt-out
 * `WindowCompat.setDecorFitsSystemWindows(window, true)` is ignored. So the activity enables
 * edge-to-edge explicitly (which also makes Android 14 and older behave the same way) and the
 * Capacitor `SystemBars` core plugin (`plugins.SystemBars.insetsHandling` in capacitor.config.ts)
 * together with the app's `env(safe-area-inset-*)` CSS keep content clear of the bars.
 *
 * `EdgeToEdge.enable` must run before `super.onCreate` so the window is configured before the
 * Capacitor bridge creates the WebView.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // FLAG_SECURE must be set before super.onCreate so it is in place before the first frame.
        if (SecureWindowPolicy.shouldSetSecureFlag(getApplicationInfo())) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
        // EdgeToEdge.enable touches the window decor, which AppCompat then builds from the theme in effect
        // at that moment. Capacitor's BridgeActivity only switches from the splash launch theme to
        // NoActionBar after super.onCreate, too late: the decor would get a native action bar that
        // covers the top of the page. Applying the NoActionBar theme first prevents that.
        setTheme(R.style.AppTheme_NoActionBar);
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
    }
}
