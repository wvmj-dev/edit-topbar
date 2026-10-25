#!/usr/bin/env bash
# Smoke test: runs the extension in a throwaway headless GNOME Shell, changes
# the settings through a few scenarios, checks the top bar after each one,
# saves screenshots and fails on any JavaScript error. Nothing touches the
# real session: the shell gets its own D-Bus session bus, dconf database and
# XDG_DATA_HOME, and no display.
#
#   tests/smoke.sh <output dir>     (normally run through ./build.sh test)
#
# The extension is staged from the working tree into a temporary directory,
# so the copy installed in ~/.local is neither used nor changed.
set -euo pipefail

if [ -z "${ETB_SMOKE_INNER:-}" ]; then
    root=$(cd "$(dirname "$0")/.." && pwd)
    out=$(mkdir -p "${1:-$root/tests/output}" && cd "${1:-$root/tests/output}" && pwd)
    uuid=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' "$root/metadata.json")
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT

    ext="$work/share/gnome-shell/extensions"
    mkdir -p "$ext"
    "$root/build.sh" stage "$ext"
    cp -r "$root/tests/devtools" "$ext/edit-topbar-devtools@local"
    rm -f "$out"/*.png "$out"/*.log

    echo "user-db:edit_topbar_test" >"$work/dconf-profile"
    export DCONF_PROFILE="$work/dconf-profile"
    # Wipes the whole test database, so refuse unless it really is the test one.
    reset_test_db() {
        [ "$DCONF_PROFILE" = "$work/dconf-profile" ] &&
            grep -qx "user-db:edit_topbar_test" "$DCONF_PROFILE" || {
            echo "refusing to reset dconf: unexpected profile"
            exit 1
        }
        dconf reset -f /
    }
    reset_test_db
    dconf write /org/gnome/shell/enabled-extensions "['$uuid', 'edit-topbar-devtools@local']"
    dconf write /org/gnome/shell/welcome-dialog-last-shown-version "'999'"

    export ETB_SMOKE_INNER=1 ETB_UUID=$uuid ETB_OUT=$out ETB_WORK=$work
    status=0
    # Services on the private bus are chatty; keep their output in a file.
    dbus-run-session -- "$0" 2>"$out/session.log" || status=$?
    reset_test_db
    exit $status
fi

# --- Inside the private session bus ---------------------------------------
P=/org/gnome/shell/extensions/edit-topbar/
log="$ETB_OUT/shell.log"

XDG_DATA_HOME="$ETB_WORK/share" \
    gnome-shell --headless --virtual-monitor 1280x800 >"$log" 2>&1 &
shell=$!
trap 'kill $shell 2>/dev/null; wait $shell 2>/dev/null' EXIT

js() {
    local reply
    reply=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>&1) || { echo "$reply"; return 1; }
    [[ $reply == "(true,"* ]] || { echo "Eval failed: $1 -> $reply"; return 1; }
    echo "$reply"
}
# Runs an expression for its side effects; any failure stops the test.
run() {
    local reply
    reply=$(js "$1") || { echo "$reply"; exit 1; }
}
# True only when the expression evaluates to true. Eval replies
# "(true, '<result>')", where the first true just means the call worked.
is_true() { [[ $(js "$1" 2>/dev/null) == "(true, 'true')" ]]; }
# Fails the test with a message unless the expression is true.
expect() { is_true "$1" || { echo "FAILED: $2"; exit 1; }; }
shot() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$ETB_OUT/$1.png" >/dev/null
    echo "  screenshot: $ETB_OUT/$1.png"
}
pause() { sleep "${1:-0.6}"; }

EXT="Main.extensionManager.lookup('$ETB_UUID')"
OBJ="$EXT.stateObj"
SA="Main.panel.statusArea"
# Container of a panel item, and the box it is in.
item() { echo "$SA['$1'].container"; }
in_box() { echo "Main.panel._$2Box.contains($(item "$1"))"; }
shown() { echo "$(item "$1").visible"; }
STATUS="$SA.quickSettings._indicators"

for _ in $(seq 1 60); do
    is_true "$EXT?.state === 1 && global.context.unsafe_mode" && break
    sleep 0.5
done
expect "$EXT.state === 1" "extension did not start"
run "Main.overview.hide(); 1"
pause 1.5

echo "1. default top bar, items are published for the preferences"
expect "$OBJ._items.has('activities') && $OBJ._items.has('dateMenu') && $OBJ._items.has('quickSettings')" \
    "built-in items not found"
expect "$OBJ._items.has('status:system') && $OBJ._items.has('status:volumeOutput')" "status icons not found"
known=$(dconf read ${P}known-items)
[[ $known == *"'dateMenu', 'center'"* ]] || { echo "FAILED: known-items not written: $known"; exit 1; }
expect "!$OBJ._moved" "something moved without a layout"
shot 01-default

echo "2. clock on the left, system menu first on the right, battery first in the icons"
dconf write ${P}layout "{'left': ['activities', 'dateMenu'], 'center': [], 'right': ['quickSettings', 'keyboard', 'a11y', 'dwellClick', 'screenSharing', 'screenRecording']}"
# Status ids depend on the hardware, so build that list from what was found.
run "const s = $OBJ._settings; const l = s.get_value('layout').deepUnpack();
     const ids = [...$OBJ._items.keys()].filter(i => i.startsWith('status:') && i !== 'status:system');
     l.status = ['status:system', ...ids];
     s.set_value('layout', new imports.gi.GLib.Variant('a{sas}', l)); 1"
pause
expect "$(in_box dateMenu left)" "clock was not moved to the left"
expect "Main.panel._rightBox.get_first_child() === $(item quickSettings)" "system menu is not first on the right"
expect "$STATUS.get_first_child() === $SA.quickSettings._system" "battery icon is not first"
shot 02-moved

echo "3. a new indicator lands after its neighbour"
run "import('resource:///org/gnome/shell/ui/panelMenu.js').then(PanelMenu => {
     const St = imports.gi.St;
     const b = new PanelMenu.Button(0.5, 'Test indicator', true);
     b.add_child(new St.Icon({icon_name: 'face-smile-symbolic', style_class: 'system-status-icon'}));
     Main.panel.addToStatusArea('smoke-test', b, 0, 'right'); }); 1"
pause
expect "$(in_box smoke-test right)" "test indicator is not in the right box"
expect "$OBJ._items.has('smoke-test')" "test indicator not discovered"

echo "4. rules: never, overview only, reveal shortcut"
dconf write ${P}rules "{'activities': 'never', 'smoke-test': 'overview', 'status:volumeOutput': 'never'}"
pause
expect "!$(shown activities)" "activities still visible with rule never"
expect "!$(shown smoke-test)" "overview-only item visible on the desktop"
expect "!$SA.quickSettings._volumeOutput.visible" "volume icon still visible with rule never"
shot 03-hidden
run "Main.overview.show(); 1"; pause 1.5
expect "$(shown smoke-test)" "overview-only item hidden in the overview"
shot 04-overview
run "Main.overview.hide(); 1"; pause 1.5
expect "!$(shown smoke-test)" "overview-only item still visible after the overview"
run "$OBJ._toggleReveal(); 1"; pause
expect "$(shown activities) && $(shown smoke-test)" "reveal did not show hidden items"
shot 05-revealed
run "$OBJ._toggleReveal(); 1"; pause
expect "!$(shown activities)" "items not hidden again after reveal"

echo "5. reveal timeout"
dconf write ${P}reveal-timeout 1
run "$OBJ._toggleReveal(); 1"; pause 0.3
expect "$(shown activities)" "reveal did not show hidden items"
pause 1.5
expect "!$(shown activities)" "revealed items did not hide after the timeout"
dconf reset ${P}reveal-timeout

echo "6. hover and workspace rules"
dconf write ${P}hover-delay 0
dconf write ${P}rules "{'keyboard': 'hover', 'smoke-test': 'empty-workspace', 'activities': 'windows'}"
pause
expect "!$(shown keyboard)" "hover item visible without hover"
run "Main.panel.hover = true; 1"; pause 0.3
expect "$(shown keyboard)" "hover item hidden while hovering"
run "Main.panel.hover = false; 1"; pause 0.3
expect "!$(shown keyboard)" "hover item still visible after leaving"
expect "$(shown smoke-test) && !$(shown activities)" "workspace rules wrong on an empty workspace"
run "$OBJ._setState('windows', true); 1"; pause 0.3
expect "!$(shown smoke-test) && $(shown activities)" "workspace rules wrong with windows"
run "$OBJ._syncWindows(); 1"
dconf reset ${P}hover-delay

echo "7. per-item shortcut"
dconf write ${P}shortcuts "{'dateMenu': '<Super><Alt>1'}"
pause
expect "$OBJ._grabs.size === 1" "item shortcut was not grabbed"
run "$OBJ._toggleItem('dateMenu'); 1"; pause 0.3
expect "!$(shown dateMenu)" "item shortcut did not hide the clock"
run "$OBJ._toggleItem('dateMenu'); 1"; pause 0.3
expect "$(shown dateMenu)" "second press did not return the clock to its rule"
dconf reset ${P}shortcuts
pause
expect "$OBJ._grabs.size === 0" "item shortcut not released"

echo "8. the indicator's own visibility is kept while hidden"
dconf write ${P}rules "{'status:system': 'never'}"
pause
run "$SA.quickSettings._system.visible = true; 1"; pause 0.3
expect "!$SA.quickSettings._system.visible" "an icon re-showed itself while hidden"
dconf reset ${P}rules
pause
expect "$SA.quickSettings._system.visible === $SA.quickSettings._system.get_children().some(c => c.visible)" \
    "battery icon did not get its own visibility back"

echo "9. reset puts every item back"
dconf reset ${P}layout
pause
expect "$(in_box dateMenu center) && $(in_box activities left)" "items not restored after a reset"
expect "Main.panel._rightBox.get_last_child() === $(item quickSettings)" \
    "system menu not back at the end"
shot 06-reset

echo "10. disable restores the top bar"
dconf write ${P}layout "{'left': ['activities', 'quickSettings'], 'right': ['dateMenu']}"
dconf write ${P}rules "{'activities': 'never'}"
pause
expect "$(in_box quickSettings left) && !$(shown activities)" "layout not applied before disable"
run "Main.extensionManager.disableExtension('$ETB_UUID'); 1"; pause
expect "$(in_box quickSettings right) && $(in_box dateMenu center) && $(shown activities)" \
    "top bar not restored on disable"
run "Main.extensionManager.enableExtension('$ETB_UUID'); 1"; pause 1
expect "$(in_box quickSettings left) && !$(shown activities)" "layout not applied again after enable"
run "$SA['smoke-test'].destroy(); 1"; pause
dconf reset ${P}rules
dconf write ${P}layout "{'left': ['activities', 'dateMenu'], 'right': ['quickSettings']}"
dconf write ${P}rules "{'a11y': 'hover', 'status:volumeInput': 'never'}"
dconf write ${P}shortcuts "{'dateMenu': '<Super><Alt>1'}"
pause

echo "11. preferences window"
n=7
for page in items behavior item; do
    # The prefs app is D-Bus activated: pass the page through the activation
    # environment and restart only the instance on this private bus.
    if [ $page = item ]; then
        dbus-update-activation-environment EDIT_TOPBAR_PREFS_PAGE=items EDIT_TOPBAR_PREFS_ITEM=dateMenu
    else
        dbus-update-activation-environment EDIT_TOPBAR_PREFS_PAGE=$page
    fi
    pid=$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.GetConnectionUnixProcessID org.gnome.Shell.Extensions 2>/dev/null |
        grep -o '[0-9]\+' | tail -1 || true)
    [ -n "$pid" ] && kill "$pid" && pause 1
    gnome-extensions prefs "$ETB_UUID" >/dev/null 2>&1 || true
    pause 4
    shot "0$n-preferences-$page"
    n=$((n + 1))
done

errors=$(grep -E "JS ERROR|JS WARNING|$ETB_UUID.*(rror|Exception)|Gjs-CRITICAL" "$log" || true)
if [ -n "$errors" ]; then
    echo "FAILED: errors in $log"
    echo "$errors"
    exit 1
fi
echo "OK: no JavaScript errors (log: $log)"
