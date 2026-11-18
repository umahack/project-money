package online.projectmoney.app;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

/**
 * On Android 15 (API 35+) `targetSdk 35` makes the window edge-to-edge by
 * default — the status bar and camera cutout sit on top of the WebView
 * regardless of StatusBar plugin settings. Forcing the decor to fit system
 * windows restores Android-14-style layout so the WebView starts BELOW the
 * cutout. The Capacitor StatusBar plugin's background colour still applies
 * to the reserved area.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
    }
}
