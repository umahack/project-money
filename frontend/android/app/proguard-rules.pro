# ProGuard/R8 rules for the release build (minifyEnabled true, shrinkResources true).
#
# capacitor-android already ships consumer rules that keep @CapacitorPlugin /
# @NativePlugin classes, their @PluginMethod / @PermissionCallback /
# @ActivityCallback methods, and Cordova plugin classes. The rules below repeat
# the ones the app depends on so that they hold even if a plugin library stops
# shipping them.

# Preserve annotations and signatures that Capacitor reads reflectively at runtime.
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod, Exceptions

# Capacitor loads plugins by class name from capacitor.plugins.json
# (PluginManager -> Class.forName), so plugin classes and their JS-callable
# methods must keep their names.
-keep public class * extends com.getcapacitor.Plugin { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * {
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.annotation.ActivityCallback <methods>;
    @com.getcapacitor.annotation.Permission <methods>;
    @com.getcapacitor.PluginMethod public <methods>;
}
-keep @com.getcapacitor.NativePlugin public class * {
    @com.getcapacitor.PluginMethod public <methods>;
}
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.annotation.ActivityCallback <methods>;
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.PluginMethod <methods>;
}
-keep @interface com.getcapacitor.annotation.** { *; }
-keep @interface com.getcapacitor.PluginMethod { *; }
-keep @interface com.getcapacitor.NativePlugin { *; }

# Official Capacitor plugins used by the app (app, haptics, keyboard, status-bar).
-keep class com.capacitorjs.plugins.** { *; }

# Capacitor core classes the bridge resolves by name (e.g. CapacitorHttp, CapacitorCookies).
-keep class com.getcapacitor.** { *; }

# Cordova-compat plugins loaded by Capacitor's Cordova bridge.
-keep public class * extends org.apache.cordova.CordovaPlugin { *; }
-keep public class * extends org.apache.cordova.* {
    public <methods>;
    public <fields>;
}

# Methods exposed to the WebView through addJavascriptInterface are called from
# JavaScript by name, so they must not be renamed or removed.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# The app's own classes (MainActivity, SecureWindowPolicy) are small; keep them
# unobfuscated so the Capacitor bridge, manifest and any reflection resolve them.
-keep class online.projectmoney.app.** { *; }

# Keep line numbers for readable crash stack traces while hiding source file names.
-keepattributes SourceFile, LineNumberTable
-renamesourcefileattribute SourceFile
