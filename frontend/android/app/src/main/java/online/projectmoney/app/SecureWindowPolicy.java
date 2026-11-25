package online.projectmoney.app;

import android.content.pm.ApplicationInfo;

/**
 * Decides whether {@link MainActivity} sets {@code FLAG_SECURE} on its window.
 *
 * {@code FLAG_SECURE} hides the app from screenshots, screen recording and the recent-apps
 * thumbnail. It is on in every build that is not debuggable (the release build) and off in debug
 * builds, so emulator screenshots and visual checks keep working. Deriving the decision from the
 * installed APK's {@code FLAG_DEBUGGABLE} ties it to the Gradle build type without a second
 * source of truth. There is deliberately no setting to turn it off.
 */
public final class SecureWindowPolicy {
    private SecureWindowPolicy() {}

    /** Returns true when the application is not debuggable. */
    public static boolean shouldSetSecureFlag(ApplicationInfo appInfo) {
        return shouldSetSecureFlag(appInfo.flags);
    }

    /**
     * Pure form of the decision on the raw {@code ApplicationInfo.flags} bit field, so it can be
     * unit-tested on the JVM without constructing an Android object.
     */
    static boolean shouldSetSecureFlag(int applicationInfoFlags) {
        return (applicationInfoFlags & ApplicationInfo.FLAG_DEBUGGABLE) == 0;
    }
}
