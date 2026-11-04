#!/usr/bin/env bash
set -euo pipefail

# Run only on a dedicated emulator. No production account or carrier SIM is needed.
serial="${1:?Usage: bash scripts/test-default-messenger-emulator.sh emulator-5554}"
[[ "$serial" == emulator-* ]] || { echo "A dedicated emulator serial is required." >&2; exit 1; }
adb_bin="${ANDROID_HOME:?Set ANDROID_HOME}/platform-tools/adb"
build_dir="${GROGONI_ANDROID_BUILD_DIR:-apps/android}"
report_dir="${GROGONI_EMULATOR_REPORT_DIR:-/tmp/grogoni-default-messenger-results}"
mkdir -p "$report_dir"

"$adb_bin" -s "$serial" wait-for-device
[[ "$("$adb_bin" -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]] || {
  echo "Wait for Android to finish booting." >&2; exit 1;
}
"$adb_bin" -s "$serial" install -r "$build_dir/app/build/outputs/apk/debug/app-debug.apk"
"$adb_bin" -s "$serial" install -r "$build_dir/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
"$adb_bin" -s "$serial" shell cmd role add-role-holder --user 0 android.app.role.SMS market.grogoni.app
for permission in READ_SMS SEND_SMS RECEIVE_SMS RECEIVE_MMS RECEIVE_WAP_PUSH READ_PHONE_STATE; do
  "$adb_bin" -s "$serial" shell pm grant market.grogoni.app "android.permission.$permission"
done

instrument() {
  local report="$1"
  shift
  "$adb_bin" -s "$serial" shell am instrument -w "$@" market.grogoni.app.test/androidx.test.runner.AndroidJUnitRunner | tee "$report_dir/$report.txt"
  # Android's am command can exit 0 even when JUnit fails.
  grep -q 'OK (' "$report_dir/$report.txt"
  ! grep -Eq 'FAILURES|INSTRUMENTATION_FAILED|Process crashed' "$report_dir/$report.txt"
}

fixture='market.grogoni.app.sms.MessengerReadinessInstrumentedTest#emulatedSmsBroadcastIsStoredLocallyWithoutBackendCopy'
instrument prepare -e class "$fixture" -e stage prepare
"$adb_bin" -s "$serial" emu sms send +15551234567 grogoni-emulator-private-sms-20261103
# The broadcast receiver does durable work off the main thread. Wait for its notification.
for attempt in {1..20}; do
  if "$adb_bin" -s "$serial" shell dumpsys notification --noredact | grep -q 'New SMS'; then break; fi
  sleep 1
done
instrument incoming-private-sms -e class "$fixture"
instrument messenger -e class market.grogoni.app.sms.MessengerReadinessInstrumentedTest,market.grogoni.app.sms.MmsInstrumentedTest,market.grogoni.app.sms.SharedMessengerUiInstrumentedTest
instrument existing-native -e class market.grogoni.app.sms.LocalSmsInboxInstrumentedTest,market.grogoni.app.sms.NativeSmsStoreInstrumentedTest,market.grogoni.app.auth.NativeAuthInstrumentedTest
"$adb_bin" -s "$serial" shell am start -n market.grogoni.app/.MainActivity
echo "Emulator verification passed. Reports: $report_dir"
