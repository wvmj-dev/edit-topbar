#!/usr/bin/env bash
# Build, install, test or pack the extension.
#   ./build.sh            compile schemas and translations in place
#   ./build.sh install    build and install to ~/.local/share/gnome-shell/extensions
#   ./build.sh stage DIR  build and copy the extension to DIR/<uuid> (used by the tests)
#   ./build.sh unit       run the unit tests (gjs only, a few seconds)
#   ./build.sh test       unit tests, then tests/smoke.sh in a headless shell (screenshots in tests/output)
#   ./build.sh dev        install and run a nested GNOME Shell to test without logging out
#   ./build.sh prefs      install and reopen the preferences window with the new prefs.js
#   ./build.sh pack       build a zip ready for extensions.gnome.org
#   ./build.sh pot        regenerate po/edit-topbar.pot
set -euo pipefail
cd "$(dirname "$0")"

UUID=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' metadata.json)
DOMAIN=edit-topbar
# Every JavaScript file the extension needs at run time.
SOURCES=(extension.js prefs.js rules.js panel.js)
# Shortcut inside ./build.sh dev; the host shell keeps the real one.
DEV_SHORTCUT='<Super><Alt>j'

build() {
    glib-compile-schemas --strict schemas
    for po in po/*.po; do
        lang=$(basename "$po" .po)
        mkdir -p "locale/$lang/LC_MESSAGES"
        msgfmt --check -o "locale/$lang/LC_MESSAGES/$DOMAIN.mo" "$po"
    done
}

stage() {
    build
    dest="$1/$UUID"
    rm -rf "$dest"
    mkdir -p "$dest"
    cp -r metadata.json "${SOURCES[@]}" schemas locale "$dest"
}

install() {
    stage "$HOME/.local/share/gnome-shell/extensions"
    echo "Installed to $dest"
}

case "${1:-build}" in
build) build ;;
install)
    install
    echo "The running shell keeps the old code: use '$0 dev' to test, or log out and back in."
    ;;
dev)
    install
    # GNOME 49+ replaced --nested with --devkit (package mutter-devkit).
    major=$(gnome-shell --version | grep -o '[0-9]\+' | head -1)
    if [ "$major" -ge 49 ]; then mode=--devkit; else mode=--nested; fi
    missing=()
    command -v dbus-run-session >/dev/null || missing+=(dbus-daemon)
    [ "$mode" = --devkit ] && [ ! -x /usr/libexec/mutter-devkit ] && missing+=(mutter-devkit)
    if [ ${#missing[@]} -gt 0 ]; then
        echo "Missing packages: ${missing[*]} (Fedora: sudo dnf install ${missing[*]})" >&2
        exit 1
    fi
    # The nested shell gets its own dconf database: only this extension is
    # enabled, and the reveal shortcut is changed because the host shell
    # grabs ours. The extension settings are copied from the real session on
    # every run.
    settings_path=/org/gnome/shell/extensions/$DOMAIN/
    current=$(dconf dump "$settings_path")
    profile="${XDG_CACHE_HOME:-$HOME/.cache}/$DOMAIN/dconf-profile"
    mkdir -p "$(dirname "$profile")"
    # D-Bus object paths (used by dconf for the database name) forbid hyphens.
    echo "user-db:${DOMAIN//-/_}_dev" >"$profile"
    export DCONF_PROFILE=$profile
    dconf reset -f "$settings_path"
    [ -n "$current" ] && dconf load "$settings_path" <<<"$current"
    dconf write "${settings_path}reveal-shortcut" "['$DEV_SHORTCUT']"
    dconf write /org/gnome/shell/enabled-extensions "['$UUID']"
    dconf write /org/gnome/shell/welcome-dialog-last-shown-version "'999'"

    export MUTTER_DEBUG_DUMMY_MODE_SPECS=${MUTTER_DEBUG_DUMMY_MODE_SPECS:-1600x900}
    echo "Starting nested GNOME Shell ($mode). Reveal hidden items with $DEV_SHORTCUT."
    echo "Settings come from your session: change them there and run '$0 dev' again."
    # Show only this extension's messages and JS errors with their stack traces.
    set +e
    dbus-run-session -- gnome-shell $mode 2>&1 |
        grep --line-buffered -E "$UUID|JS ERROR|JS WARNING|@(file|resource):"
    status=${PIPESTATUS[0]}
    set -e
    if [ "$status" -ne 0 ]; then
        echo "gnome-shell exited with status $status. Run it unfiltered to see why:" >&2
        echo "  dbus-run-session -- gnome-shell $mode" >&2
    fi
    ;;
stage)
    [ -n "${2:-}" ] || { echo "usage: $0 stage DIR" >&2; exit 1; }
    stage "$2"
    ;;
unit)
    gjs -m tests/unit.js
    ;;
test)
    # Nothing is installed in the real session; smoke.sh stages its own copy.
    gjs -m tests/unit.js
    tests/smoke.sh "${2:-tests/output}"
    ;;
prefs)
    install
    # The prefs process caches modules; kill it so the new prefs.js is loaded.
    pkill -f 'gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensions' || true
    gnome-extensions prefs "$UUID"
    ;;
pack)
    build
    extra=()
    for file in "${SOURCES[@]}"; do
        case $file in extension.js | prefs.js) ;; *) extra+=("--extra-source=$file") ;; esac
    done
    gnome-extensions pack --force --podir=po "${extra[@]}" .
    ;;
pot)
    xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ \
        --package-name="$UUID" -o "po/$DOMAIN.pot" "${SOURCES[@]}"
    for po in po/*.po; do msgmerge -U --backup=none "$po" "po/$DOMAIN.pot"; done
    ;;
*) echo "usage: $0 [build|install|stage|unit|test|dev|prefs|pack|pot]" >&2; exit 1 ;;
esac
