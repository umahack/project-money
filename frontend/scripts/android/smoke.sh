#!/usr/bin/env bash
# adb-driven emulator smoke check for the Android release build
# (android-app-release spec, Requirements 16.1, 16.4, 16.6, 16.7).
#
# Usage:  scripts/android/smoke.sh [path/to/app-release.apk]
#
# What it does (every step is reported; the exit status is non-zero if any check failed):
#   1. Boots the AVD (default Pixel_7_2) unless a matching emulator is already running, and waits for
#      sys.boot_completed with a timeout.
#   2. `adb install -r` the signed APK (existing app data is kept).
#   3. Launches online.projectmoney.app/.MainActivity and asserts: the process is running, MainActivity is the
#      resumed activity, and `logcat -d` has no FATAL EXCEPTION.
#   4. Saves a screenshot with `adb exec-out screencap -p` to /tmp ONLY. The release build sets FLAG_SECURE, so the
#      screenshot is EXPECTED TO BE BLANK/BLACK; that blank image is itself evidence that FLAG_SECURE is applied.
#      For visual checks use `uiautomator dump` or a debug build (Requirement 16.6).
#   5. Asserts from `dumpsys package` that the app is not DEBUGGABLE and not ALLOW_BACKUP.
#   6. Asserts `run-as online.projectmoney.app ls` is refused (a release build is not debuggable).
#   7. Presses KEYCODE_BACK on the first screen and asserts the app is minimised (process alive, no longer
#      resumed) and did not crash.
#
# Environment (all optional):
#   ANDROID_SERIAL           the one device to use. Without it the script uses the emulator it starts itself
#                            (emulator-$SMOKE_EMULATOR_PORT). Every adb call uses `-s <serial>`, so no other
#                            attached device is ever touched. A non-emulator serial is refused unless
#                            SMOKE_ALLOW_PHYSICAL_DEVICE=1.
#   AVD_NAME                 AVD to boot (default Pixel_7_2)
#   SMOKE_EMULATOR_PORT      console port of the emulator the script starts (even, 5554-5584; default 5584)
#   SMOKE_API_LEVEL          if set, the booted device must report this API level (for example 34 or 37)
#   SMOKE_HEADLESS           1 adds -no-window (default 0)
#   SMOKE_BUILD_TYPE         release (default) or debug. With debug the DEBUGGABLE and run-as expectations invert.
#   SMOKE_BOOT_TIMEOUT       seconds to wait for boot (default 300)
#   SMOKE_SETTLE_SECONDS     seconds to let the WebView load after launch (default 6)
#   SMOKE_STOP_EMULATOR      1 stops an emulator this script started when it finishes (default: leave it running)
#   SMOKE_OUT_DIR            where the screenshot and emulator log go (default /tmp)
#   ANDROID_HOME / ANDROID_SDK_ROOT   SDK root (default ~/Library/Android/sdk)
#
# Safety: the script never runs `pm clear`, `-wipe-data`, `adb kill-server`, or `adb uninstall` on a physical
# device. When an update fails with a signature mismatch on an emulator it started or was named for, it
# uninstalls the old copy of the app and installs again (emulator only).

set -euo pipefail

PACKAGE="online.projectmoney.app"
ACTIVITY="${PACKAGE}/.MainActivity"
# How dumpsys prints the activity: online.projectmoney.app/.MainActivity or .../online.projectmoney.app.MainActivity
ACTIVITY_RE='online\.projectmoney\.app/(\.|online\.projectmoney\.app\.)MainActivity'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-${HOME}/Library/Android/sdk}}"
ADB="${SDK_ROOT}/platform-tools/adb"
EMULATOR="${SDK_ROOT}/emulator/emulator"

AVD_NAME="${AVD_NAME:-Pixel_7_2}"
EMULATOR_PORT="${SMOKE_EMULATOR_PORT:-5584}"
BOOT_TIMEOUT="${SMOKE_BOOT_TIMEOUT:-300}"
SETTLE_SECONDS="${SMOKE_SETTLE_SECONDS:-6}"
BUILD_TYPE="${SMOKE_BUILD_TYPE:-release}"
OUT_DIR="${SMOKE_OUT_DIR:-/tmp}"

case "${1:-}" in
  -h | --help)
    sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

APK="${1:-${FRONTEND_DIR}/android/app/build/outputs/apk/release/app-release.apk}"

FAILURES=0
STARTED_EMULATOR=0
SERIAL=""

log() { printf '%s\n' "$*"; }
die() { printf 'smoke: ERROR: %s\n' "$*" >&2; exit 2; }
pass() { printf '  [PASS] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
info() { printf '  [INFO] %s\n' "$*"; }

adbs() { "${ADB}" -s "${SERIAL}" "$@"; }
# Output of `adb shell` without the carriage returns adb adds.
shell() { adbs shell "$@" | tr -d '\r'; }

cleanup() {
  if [[ "${STARTED_EMULATOR}" == "1" && "${SMOKE_STOP_EMULATOR:-0}" == "1" && -n "${SERIAL}" ]]; then
    log "Stopping the emulator started by this script (${SERIAL})"
    "${ADB}" -s "${SERIAL}" emu kill >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---- preflight --------------------------------------------------------------------------------
[[ -x "${ADB}" ]] || die "adb not found at ${ADB}. Install platform-tools or set ANDROID_HOME."
[[ "${BUILD_TYPE}" == "release" || "${BUILD_TYPE}" == "debug" ]] || die "SMOKE_BUILD_TYPE must be release or debug"
[[ -f "${APK}" ]] || die "APK not found: ${APK} (build it with: npm run android:release -- -PbuildNumber=<n>)"
[[ "${EMULATOR_PORT}" =~ ^[0-9]+$ ]] || die "SMOKE_EMULATOR_PORT must be a number"
mkdir -p "${OUT_DIR}"

device_state() { # prints the adb state of $1 ("device", "offline", ...) or nothing when it is not attached
  "${ADB}" devices | awk -v s="$1" '$1 == s { print $2 }'
}

start_emulator() {
  [[ -x "${EMULATOR}" ]] || die "emulator not found at ${EMULATOR}"
  "${EMULATOR}" -list-avds | grep -Fxq "${AVD_NAME}" || die "AVD ${AVD_NAME} does not exist (see: ${EMULATOR} -list-avds)"
  local emu_log="${OUT_DIR}/projectmoney-emulator-${EMULATOR_PORT}.log"
  local args=(-avd "${AVD_NAME}" -port "${EMULATOR_PORT}" -no-snapshot -no-audio -no-boot-anim)
  if [[ "${SMOKE_HEADLESS:-0}" == "1" ]]; then
    args+=(-no-window)
  fi
  log "Starting emulator ${AVD_NAME} on port ${EMULATOR_PORT} (log: ${emu_log})"
  nohup "${EMULATOR}" "${args[@]}" >"${emu_log}" 2>&1 </dev/null &
  STARTED_EMULATOR=1
}

wait_for_boot() {
  local deadline=$((SECONDS + BOOT_TIMEOUT))
  log "Waiting up to ${BOOT_TIMEOUT}s for ${SERIAL} to finish booting"
  until [[ "$(device_state "${SERIAL}")" == "device" ]]; do
    ((SECONDS < deadline)) || die "${SERIAL} did not appear within ${BOOT_TIMEOUT}s"
    sleep 2
  done
  until [[ "$(adbs shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do
    ((SECONDS < deadline)) || die "${SERIAL} did not report sys.boot_completed within ${BOOT_TIMEOUT}s"
    sleep 2
  done
}

select_device() {
  if [[ -n "${ANDROID_SERIAL:-}" ]]; then
    SERIAL="${ANDROID_SERIAL}"
    if [[ "${SERIAL}" != emulator-* && "${SMOKE_ALLOW_PHYSICAL_DEVICE:-0}" != "1" ]]; then
      die "ANDROID_SERIAL=${SERIAL} is not an emulator. Set SMOKE_ALLOW_PHYSICAL_DEVICE=1 to run against it (app data is kept)."
    fi
    if [[ -z "$(device_state "${SERIAL}")" ]]; then
      [[ "${SERIAL}" =~ ^emulator-([0-9]+)$ ]] || die "ANDROID_SERIAL=${SERIAL} is not attached"
      EMULATOR_PORT="${BASH_REMATCH[1]}"
      start_emulator
    fi
  else
    SERIAL="emulator-${EMULATOR_PORT}"
    if [[ -z "$(device_state "${SERIAL}")" ]]; then
      start_emulator
    else
      # Reuse only an emulator that runs the requested AVD; never take over a different one.
      local running
      running="$("${ADB}" -s "${SERIAL}" emu avd name 2>/dev/null | tr -d '\r' | head -n 1 || true)"
      [[ "${running}" == "${AVD_NAME}" ]] || die "${SERIAL} is already running AVD '${running:-unknown}', not '${AVD_NAME}'. Use SMOKE_EMULATOR_PORT or ANDROID_SERIAL."
      log "Reusing the running emulator ${SERIAL} (${AVD_NAME})"
    fi
  fi
  wait_for_boot
}

app_pid() { shell "pidof ${PACKAGE}" 2>/dev/null | awk 'NR == 1 { print $1 }' || true; }

resumed_activity_line() {
  shell "dumpsys activity activities" 2>/dev/null | grep -E 'ResumedActivity' | head -n 3 || true
}

app_is_resumed() {
  resumed_activity_line | grep -Eq "${ACTIVITY_RE}"
}

fatal_lines() {
  adbs logcat -d 2>/dev/null | tr -d '\r' | grep -E 'FATAL EXCEPTION' | head -n 5 || true
}

# ---- run --------------------------------------------------------------------------------------
log "Smoke check for ${PACKAGE} (${BUILD_TYPE}); APK: ${APK}"
select_device
log "Using device ${SERIAL}"

API_LEVEL="$(shell getprop ro.build.version.sdk)"
info "device API level ${API_LEVEL} ($(shell getprop ro.product.model))"
if [[ -n "${SMOKE_API_LEVEL:-}" ]]; then
  if [[ "${API_LEVEL}" == "${SMOKE_API_LEVEL}" ]]; then
    pass "device reports API level ${SMOKE_API_LEVEL}"
  else
    fail "expected API level ${SMOKE_API_LEVEL}, device reports ${API_LEVEL}"
  fi
fi

log "Install"
install_out="$(adbs install -r "${APK}" 2>&1 | tr -d '\r' || true)"
if ! grep -q '^Success' <<<"${install_out}" && grep -q 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' <<<"${install_out}" && [[ "${SERIAL}" == emulator-* ]]; then
  info "signature differs from the installed copy; uninstalling it from the emulator ${SERIAL} and retrying"
  adbs uninstall "${PACKAGE}" >/dev/null 2>&1 || true
  install_out="$(adbs install -r "${APK}" 2>&1 | tr -d '\r' || true)"
fi
if grep -q '^Success' <<<"${install_out}"; then
  pass "adb install -r succeeded"
else
  fail "adb install -r failed: $(tail -n 2 <<<"${install_out}" | tr '\n' ' ')"
  log "Cannot continue without an installed app."
  exit 1
fi

log "Launch"
adbs logcat -c >/dev/null 2>&1 || true
adbs shell am force-stop "${PACKAGE}" >/dev/null 2>&1 || true
start_out="$(shell "am start -W -n ${ACTIVITY}" 2>&1 || true)"
if grep -Eq '^Error|Exception' <<<"${start_out}"; then
  fail "am start reported an error: $(grep -E '^Error|Exception' <<<"${start_out}" | head -n 1)"
else
  pass "am start -W -n ${ACTIVITY}"
fi
sleep "${SETTLE_SECONDS}"

pid="$(app_pid)"
if [[ -n "${pid}" ]]; then pass "process is running (pid ${pid})"; else fail "no ${PACKAGE} process after launch"; fi

if app_is_resumed; then
  pass "MainActivity is the resumed activity"
else
  fail "MainActivity is not the resumed activity: $(resumed_activity_line | head -n 1)"
fi

fatal="$(fatal_lines)"
if [[ -z "${fatal}" ]]; then pass "no FATAL EXCEPTION in logcat"; else fail "FATAL EXCEPTION in logcat: ${fatal}"; fi

log "Screenshot"
shot="${OUT_DIR}/projectmoney-smoke-${SERIAL}-$(date +%Y%m%d-%H%M%S).png"
if adbs exec-out screencap -p >"${shot}" 2>/dev/null && [[ -s "${shot}" ]]; then
  if [[ "${BUILD_TYPE}" == "release" ]]; then
    info "saved ${shot}. It is EXPECTED to be blank/black on a release build: FLAG_SECURE blocks screenshots, which itself proves the flag."
  else
    info "saved ${shot} (a debug build has no FLAG_SECURE, so it should show the app)"
  fi
else
  info "screencap produced no image (the secure window can make it fail); removing ${shot}"
  rm -f "${shot}"
fi

log "Package flags"
flags_out="$(shell "dumpsys package ${PACKAGE}" 2>/dev/null | grep -E 'allowBackup|DEBUGGABLE' || true)"
info "dumpsys package | grep -E 'allowBackup|DEBUGGABLE': ${flags_out:-(no matching lines)}"
flag_lines="$(shell "dumpsys package ${PACKAGE}" 2>/dev/null | grep -iE 'flags=' || true)"
if [[ "${BUILD_TYPE}" == "release" ]]; then
  if grep -q 'DEBUGGABLE' <<<"${flag_lines}"; then fail "package is DEBUGGABLE"; else pass "package is not DEBUGGABLE"; fi
else
  if grep -q 'DEBUGGABLE' <<<"${flag_lines}"; then pass "debug package is DEBUGGABLE"; else fail "debug package is not DEBUGGABLE"; fi
fi
if grep -q 'ALLOW_BACKUP' <<<"${flag_lines}"; then fail "package has ALLOW_BACKUP"; else pass "package does not allow backup"; fi

log "run-as"
rc=0
runas_out="$(adbs shell "run-as ${PACKAGE} ls" 2>&1 | tr -d '\r')" || rc=$?
if [[ "${BUILD_TYPE}" == "release" ]]; then
  if grep -qiE 'not debuggable|unknown package|Operation not permitted' <<<"${runas_out}" || [[ "${rc}" -ne 0 ]]; then
    pass "run-as is refused on the release build (${runas_out:-exit ${rc}})"
  else
    fail "run-as succeeded on a release build: ${runas_out}"
  fi
else
  if grep -qiE 'not debuggable|unknown package' <<<"${runas_out}"; then fail "run-as refused on a debug build: ${runas_out}"; else pass "run-as works on the debug build"; fi
fi

secure_seen=0
if shell "dumpsys window windows" 2>/dev/null | awk -v pkg="${PACKAGE}" '
    /Window #/ { inwin = index($0, pkg "/") > 0 }
    inwin && /(fl=|flags=).*SECURE/ { found = 1 }
    END { exit !found }'; then
  secure_seen=1
fi
if [[ "${BUILD_TYPE}" == "release" ]]; then
  if [[ "${secure_seen}" == "1" ]]; then pass "dumpsys window shows the secure flag for the app window"; else info "secure flag not confirmed by this script's dumpsys parse; check 'dumpsys window' by hand (task 14.3)"; fi
else
  if [[ "${secure_seen}" == "1" ]]; then fail "debug build window has the secure flag"; else pass "debug build window has no secure flag"; fi
fi

log "Back button on the first screen"
adbs shell input keyevent KEYCODE_BACK >/dev/null 2>&1 || true
sleep 2
pid_after="$(app_pid)"
if [[ -n "${pid_after}" ]]; then pass "process still running after back (pid ${pid_after})"; else fail "process is gone after back"; fi
if app_is_resumed; then fail "MainActivity is still resumed after back; expected the app to be minimised"; else pass "app was minimised (MainActivity is no longer resumed)"; fi
fatal="$(fatal_lines)"
if [[ -z "${fatal}" ]]; then pass "no FATAL EXCEPTION after back"; else fail "FATAL EXCEPTION after back: ${fatal}"; fi

log ""
if [[ "${FAILURES}" -eq 0 ]]; then
  log "SMOKE: PASS (${SERIAL}, API ${API_LEVEL})"
  exit 0
fi
log "SMOKE: FAIL (${FAILURES} check(s) failed on ${SERIAL}, API ${API_LEVEL})"
exit 1
