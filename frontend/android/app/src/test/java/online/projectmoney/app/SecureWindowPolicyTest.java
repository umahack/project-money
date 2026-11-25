package online.projectmoney.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.pm.ApplicationInfo;
import org.junit.Test;

/**
 * Covers Requirement 12.1 / 13.2: FLAG_SECURE is set exactly when the app is not debuggable.
 * Uses the pure int overload so no Android ApplicationInfo object is needed on the JVM.
 */
public class SecureWindowPolicyTest {

    @Test
    public void noFlags_isNotDebuggable_setsSecureFlag() {
        assertTrue(SecureWindowPolicy.shouldSetSecureFlag(0));
    }

    @Test
    public void debuggableFlag_leavesSecureFlagUnset() {
        assertFalse(SecureWindowPolicy.shouldSetSecureFlag(ApplicationInfo.FLAG_DEBUGGABLE));
    }

    @Test
    public void debuggableFlagCombinedWithOtherFlags_leavesSecureFlagUnset() {
        int flags = ApplicationInfo.FLAG_DEBUGGABLE
                | ApplicationInfo.FLAG_HAS_CODE
                | ApplicationInfo.FLAG_ALLOW_CLEAR_USER_DATA;
        assertFalse(SecureWindowPolicy.shouldSetSecureFlag(flags));
    }

    @Test
    public void otherFlagsWithoutDebuggable_setsSecureFlag() {
        int flags = ApplicationInfo.FLAG_HAS_CODE
                | ApplicationInfo.FLAG_ALLOW_CLEAR_USER_DATA
                | ApplicationInfo.FLAG_SUPPORTS_RTL;
        assertTrue(SecureWindowPolicy.shouldSetSecureFlag(flags));
    }
}
