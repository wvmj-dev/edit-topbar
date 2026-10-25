import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {BOXES, PANEL_BOXES, PANEL_CONDITIONS, PANEL_MODES, RULES, mergeLayout, moveItem} from './rules.js';

const STATUS_PREFIX = 'status:';
const FALLBACK_ICON = 'application-x-addon-symbolic';

// Names and icons of GNOME's own items; other items use what the extension
// found at run time.
function builtinItems() {
    return {
        'activities': [_('Activities'), 'view-app-grid-symbolic'],
        'dateMenu': [_('Clock and calendar'), 'x-office-calendar-symbolic'],
        'quickSettings': [_('System menu'), 'emblem-system-symbolic'],
        'a11y': [_('Accessibility'), 'preferences-desktop-accessibility-symbolic'],
        'keyboard': [_('Input source'), 'input-keyboard-symbolic'],
        'dwellClick': [_('Dwell click'), 'input-mouse-symbolic'],
        'screenRecording': [_('Screen recording'), 'media-record-symbolic'],
        'screenSharing': [_('Screen sharing'), 'screen-shared-symbolic'],
        'status:remoteAccess': [_('Remote access'), 'screen-shared-symbolic'],
        'status:camera': [_('Camera'), 'camera-web-symbolic'],
        'status:volumeInput': [_('Microphone'), 'audio-input-microphone-symbolic'],
        'status:location': [_('Location'), 'location-services-active-symbolic'],
        'status:brightness': [_('Brightness'), 'display-brightness-symbolic'],
        'status:thunderbolt': [_('Thunderbolt'), 'thunderbolt-symbolic'],
        'status:nightLight': [_('Night light'), 'night-light-symbolic'],
        'status:network': [_('Network'), 'network-wireless-symbolic'],
        'status:darkMode': [_('Dark style'), 'weather-clear-night-symbolic'],
        'status:doNotDisturb': [_('Do not disturb'), 'notifications-disabled-symbolic'],
        'status:backlight': [_('Keyboard backlight'), 'keyboard-brightness-symbolic'],
        'status:bluetooth': [_('Bluetooth'), 'bluetooth-active-symbolic'],
        'status:rfkill': [_('Airplane mode'), 'airplane-mode-symbolic'],
        'status:autoRotate': [_('Auto rotate'), 'rotation-allowed-symbolic'],
        'status:volumeOutput': [_('Volume'), 'audio-volume-high-symbolic'],
        'status:unsafeMode': [_('Unsafe mode'), 'channel-insecure-symbolic'],
        'status:powerProfiles': [_('Power mode'), 'power-profile-balanced-symbolic'],
        'status:system': [_('Battery'), 'battery-good-symbolic'],
        'status:backgroundApps': [_('Background apps'), 'application-x-executable-symbolic'],
    };
}

function boxTitles() {
    return {
        left: _('Left'),
        center: _('Center'),
        right: _('Right'),
        status: _('System menu icons'),
    };
}

function panelModeTitles() {
    return {
        'always': _('Always'),
        'never': _('Hidden'),
        'auto': _('Hide automatically'),
    };
}

function panelConditionTitles() {
    return {
        'overlap': [_('A window touches the top bar'), _('Like "intellihide": windows away from the top keep it visible')],
        'maximized': [_('A window is maximized'), _('On the monitor of the top bar')],
        'windows': [_('The workspace has windows'), _('Minimized windows do not count')],
    };
}

function ruleTitles() {
    return {
        'always': _('Always'),
        'never': _('Never (only with a shortcut)'),
        'overview': _('Only in the overview'),
        'desktop': _('Only outside the overview'),
        'hover': _('Only when the pointer is over the top bar'),
        'empty-workspace': _('Only on empty workspaces'),
        'windows': _('Only when the workspace has windows'),
    };
}

function getDict(settings, key) {
    return settings.get_value(key).deepUnpack();
}

function setDict(settings, key, type, dict) {
    settings.set_value(key, new GLib.Variant(type, dict));
}

/**
 * Builds an image from an icon name or a serialized GIcon.
 *
 * @param {string} icon icon name, serialized GIcon or ''
 * @returns {Gtk.Image}
 */
function makeImage(icon) {
    // Some top bar icons come from GNOME Shell's own resources, which the
    // preferences window cannot load.
    const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
    try {
        const gicon = Gio.Icon.new_for_string(icon);
        if (gicon instanceof Gio.ThemedIcon ? gicon.get_names().some(name => theme.has_icon(name))
            : gicon instanceof Gio.FileIcon && gicon.get_file().query_exists(null))
            return Gtk.Image.new_from_gicon(gicon);
    } catch {
        // Empty or invalid icon string: use the fallback below.
    }
    return Gtk.Image.new_from_icon_name(FALLBACK_ICON);
}

/**
 * Asks for a key combination.
 *
 * @param {Gtk.Widget} parent widget the dialog belongs to
 * @param {Function} callback receives the accelerator, or '' to disable
 */
function captureShortcut(parent, callback) {
    const dialog = new Adw.AlertDialog({
        heading: _('Set Shortcut'),
        body: _('Press the new key combination, Esc to cancel or Backspace to disable.'),
    });
    dialog.add_response('cancel', _('Cancel'));

    const controller = new Gtk.EventControllerKey({
        propagation_phase: Gtk.PropagationPhase.CAPTURE,
    });
    controller.connect('key-pressed', (_c, keyval, keycode, state) => {
        const mask = state & Gtk.accelerator_get_default_mod_mask();

        if (mask === 0 && keyval === Gdk.KEY_Escape) {
            dialog.close();
            return Gdk.EVENT_STOP;
        }
        if (mask === 0 && keyval === Gdk.KEY_BackSpace) {
            callback('');
            dialog.close();
            return Gdk.EVENT_STOP;
        }
        if (!Gtk.accelerator_valid(keyval, mask))
            return Gdk.EVENT_STOP;

        callback(Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask));
        dialog.close();
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(controller);
    dialog.present(parent.get_root());
}

const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init(settings, key, title, subtitle) {
        super._init({title, subtitle, activatable: true});
        const label = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(label);

        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Reset to default'),
        });
        reset.connect('clicked', () => settings.reset(key));
        this.add_suffix(reset);

        const sync = () => {
            label.accelerator = settings.get_strv(key)[0] ?? '';
        };
        settings.connect(`changed::${key}`, sync);
        sync();
        this.connect('activated', () => captureShortcut(this, accel =>
            settings.set_strv(key, accel ? [accel] : [])));
    }
});

const ItemDialog = GObject.registerClass(
class ItemDialog extends Adw.Dialog {
    _init(page, item) {
        super._init({title: item.label, content_width: 460});
        this._page = page;
        this._item = item;
        const settings = page.settings;

        const view = new Adw.ToolbarView();
        view.add_top_bar(new Adw.HeaderBar());
        const prefs = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            description: item.id.startsWith(STATUS_PREFIX)
                ? _('Icons of the system menu can be reordered among themselves, but not moved out of it.')
                : null,
        });
        prefs.add(group);
        view.content = prefs;
        this.child = view;

        if (!item.id.startsWith(STATUS_PREFIX)) {
            const titles = boxTitles();
            const position = new Adw.ComboRow({
                title: _('Position'),
                model: Gtk.StringList.new(PANEL_BOXES.map(box => titles[box])),
                selected: PANEL_BOXES.indexOf(item.box),
            });
            position.connect('notify::selected', () => {
                const box = PANEL_BOXES[position.selected];
                if (box !== this._item.box) {
                    page.move(item.id, box, Infinity);
                    this._item.box = box;
                }
            });
            group.add(position);
        }

        const rules = getDict(settings, 'rules');
        const titles = ruleTitles();
        const show = new Adw.ComboRow({
            title: _('Show'),
            model: Gtk.StringList.new(RULES.map(rule => titles[rule])),
            selected: Math.max(0, RULES.indexOf(rules[item.id] ?? 'always')),
        });
        show.connect('notify::selected', () => {
            const current = getDict(settings, 'rules');
            const rule = RULES[show.selected];
            if (rule === 'always')
                delete current[item.id];
            else
                current[item.id] = rule;
            setDict(settings, 'rules', 'a{ss}', current);
        });
        group.add(show);

        const shortcut = new Adw.ActionRow({
            title: _('Shortcut'),
            subtitle: _('Toggles this item; press again to return to the rule above'),
            activatable: true,
        });
        const label = new Gtk.ShortcutLabel({
            disabled_text: _('None'),
            valign: Gtk.Align.CENTER,
            accelerator: getDict(settings, 'shortcuts')[item.id] ?? '',
        });
        shortcut.add_suffix(label);
        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Remove shortcut'),
        });
        shortcut.add_suffix(clear);
        const setShortcut = accel => {
            const current = getDict(settings, 'shortcuts');
            if (accel)
                current[item.id] = accel;
            else
                delete current[item.id];
            setDict(settings, 'shortcuts', 'a{ss}', current);
            label.accelerator = accel;
        };
        clear.connect('clicked', () => setShortcut(''));
        shortcut.connect('activated', () => captureShortcut(this, setShortcut));
        group.add(shortcut);
    }
});

const ItemsPage = GObject.registerClass(
class ItemsPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({name: 'items', title: _('Items'), icon_name: 'view-list-symbolic'});
        this.settings = settings;
        this._rows = [];

        const intro = new Adw.PreferencesGroup({
            description: _('Top to bottom is left to right in the top bar. Changes apply right away.'),
        });
        this._empty = new Adw.ActionRow({
            title: _('No items found'),
            subtitle: _('Enable the extension, then reopen this window.'),
        });
        intro.add(this._empty);
        this.add(intro);

        this._groups = {};
        const titles = boxTitles();
        for (const box of BOXES) {
            this._groups[box] = new Adw.PreferencesGroup({title: titles[box]});
            this.add(this._groups[box]);
        }

        for (const key of ['known-items', 'rules', 'shortcuts'])
            settings.connect(`changed::${key}`, () => this._rebuild());
        this._rebuild();
    }

    /**
     * @returns {{id: string, box: string, label: string, icon: string}[]} the
     *   items the extension found, with GNOME's own ones named in the user's
     *   language
     */
    known() {
        const builtin = builtinItems();
        return this.settings.get_value('known-items').deepUnpack().map(([id, box, label, icon]) => ({
            id, box,
            label: builtin[id]?.[0] ?? label,
            icon: builtin[id]?.[1] ?? icon,
        }));
    }

    _arrangement() {
        const shown = Object.fromEntries(BOXES.map(box => [box, []]));
        for (const item of this.known())
            shown[item.box]?.push(item.id);
        return shown;
    }

    /**
     * Moves an item and saves the new layout. The displayed list is updated
     * at once, even before the extension applies it.
     *
     * @param {string} id item id
     * @param {string} box target box
     * @param {number} index position in that box (Infinity for the end)
     */
    move(id, box, index) {
        const shown = moveItem(this._arrangement(), id, box, index);
        const saved = getDict(this.settings, 'layout');
        setDict(this.settings, 'layout', 'a{sas}', mergeLayout(shown, saved));

        const byId = new Map(this.settings.get_value('known-items').deepUnpack().map(entry => [entry[0], entry]));
        const known = BOXES.flatMap(name => shown[name].map(other => {
            const [, , label, icon] = byId.get(other);
            return [other, name, label, icon];
        }));
        this.settings.set_value('known-items', new GLib.Variant('a(ssss)', known));
    }

    /**
     * Moves an item one step; panel items cross into the next box at the
     * ends of a box.
     *
     * @param {object} item the item to move
     * @param {number} step -1 (left) or 1 (right)
     */
    _step(item, step) {
        const shown = this._arrangement();
        const ids = shown[item.box];
        const index = ids.indexOf(item.id) + step;
        if (index >= 0 && index < ids.length) {
            this.move(item.id, item.box, index);
            return;
        }
        const boxIndex = PANEL_BOXES.indexOf(item.box) + step;
        if (item.box === 'status' || boxIndex < 0 || boxIndex >= PANEL_BOXES.length)
            return;
        const box = PANEL_BOXES[boxIndex];
        this.move(item.id, box, step > 0 ? 0 : Infinity);
    }

    _rebuild() {
        for (const [row, group] of this._rows)
            group.remove(row);
        this._rows = [];

        const known = this.known();
        this._empty.visible = known.length === 0;
        const rules = getDict(this.settings, 'rules');
        const shortcuts = getDict(this.settings, 'shortcuts');
        const titles = ruleTitles();
        const counts = Object.fromEntries(BOXES.map(box => [box, known.filter(item => item.box === box).length]));
        const positions = Object.fromEntries(BOXES.map(box => [box, 0]));

        for (const item of known) {
            const group = this._groups[item.box];
            if (!group)
                continue;
            const index = positions[item.box]++;
            const subtitle = [titles[rules[item.id] ?? 'always']];
            if (shortcuts[item.id]) {
                const [, key, mods] = Gtk.accelerator_parse(shortcuts[item.id]);
                subtitle.push(Gtk.accelerator_get_label(key, mods));
            }
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(item.label, -1),
                subtitle: GLib.markup_escape_text(subtitle.join(' · '), -1),
                activatable: true,
            });
            const image = makeImage(item.icon);
            if (rules[item.id] && rules[item.id] !== 'always')
                image.add_css_class('dim-label');
            row.add_prefix(image);

            const isPanel = item.box !== 'status';
            const first = index === 0 && (!isPanel || item.box === PANEL_BOXES[0]);
            const last = index === counts[item.box] - 1 && (!isPanel || item.box === PANEL_BOXES.at(-1));
            for (const [icon, tooltip, step, disabled] of [
                ['go-up-symbolic', _('Move left'), -1, first],
                ['go-down-symbolic', _('Move right'), 1, last],
            ]) {
                const button = new Gtk.Button({
                    icon_name: icon,
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    tooltip_text: tooltip,
                    sensitive: !disabled,
                });
                button.connect('clicked', () => this._step(item, step));
                row.add_suffix(button);
            }
            row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
            row.connect('activated', () => new ItemDialog(this, {...item}).present(this.get_root()));

            group.add(row);
            this._rows.push([row, group]);
        }
        for (const box of BOXES)
            this._groups[box].visible = counts[box] > 0;
    }
});

export default class EditTopBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(620, 760);

        const items = new ItemsPage(settings);
        window.add(items);
        window.add(this._topBarPage(settings));

        const behavior = new Adw.PreferencesPage({
            name: 'behavior',
            title: _('Behavior'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(behavior);

        const reveal = new Adw.PreferencesGroup({
            title: _('Shortcuts'),
            description: _('Each item can also have its own shortcut, set on the Items page.'),
        });
        reveal.add(new ShortcutRow(settings, 'reveal-shortcut', _('Reveal hidden items'),
            _('Shows every hidden item and the top bar; press again to hide them')));
        const timeout = Adw.SpinRow.new_with_range(0, 600, 1);
        timeout.title = _('Hide revealed items after');
        timeout.subtitle = _('Seconds; 0 keeps them visible until the shortcut is pressed again');
        settings.bind('reveal-timeout', timeout, 'value', Gio.SettingsBindFlags.DEFAULT);
        reveal.add(timeout);
        behavior.add(reveal);

        const hover = new Adw.PreferencesGroup({title: _('On hover')});
        const delay = Adw.SpinRow.new_with_range(0, 5000, 100);
        delay.title = _('Hide delay');
        delay.subtitle = _('Milliseconds before items shown on hover hide after the pointer leaves the top bar');
        settings.bind('hover-delay', delay, 'value', Gio.SettingsBindFlags.DEFAULT);
        hover.add(delay);
        behavior.add(hover);

        const resetGroup = new Adw.PreferencesGroup({title: _('Reset')});
        const resetRow = new Adw.ButtonRow({
            title: _('Restore the default top bar'),
            css_classes: ['destructive-action'],
        });
        resetRow.connect('activated', () => {
            const dialog = new Adw.AlertDialog({
                heading: _('Restore the default top bar?'),
                body: _('Positions, rules, item shortcuts and the top bar visibility will be reset.'),
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('reset', _('Restore'));
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_d, response) => {
                if (response === 'reset') {
                    for (const key of ['layout', 'rules', 'shortcuts', 'panel-mode', 'panel-hide-when',
                        'panel-show-in-overview', 'panel-reveal-on-pressure'])
                        settings.reset(key);
                }
            });
            dialog.present(window);
        });
        resetGroup.add(resetRow);
        behavior.add(resetGroup);

        // Lets tests/smoke.sh take a screenshot of each page and of an item.
        const page = GLib.getenv('EDIT_TOPBAR_PREFS_PAGE');
        if (page)
            window.visible_page_name = page;
        const item = items.known().find(known => known.id === GLib.getenv('EDIT_TOPBAR_PREFS_ITEM'));
        if (item)
            window.connect('map', () => new ItemDialog(items, item).present(window));
    }

    _topBarPage(settings) {
        const page = new Adw.PreferencesPage({
            name: 'topbar',
            title: _('Top Bar'),
            icon_name: 'go-top-symbolic',
        });

        const visibility = new Adw.PreferencesGroup({
            title: _('Visibility'),
            description: _('While the top bar can hide, windows and the overview use its space.'),
        });
        const titles = panelModeTitles();
        const mode = new Adw.ComboRow({
            title: _('Show the top bar'),
            model: Gtk.StringList.new(PANEL_MODES.map(name => titles[name])),
        });
        const syncMode = () => {
            mode.selected = Math.max(0, PANEL_MODES.indexOf(settings.get_string('panel-mode')));
        };
        settings.connect('changed::panel-mode', syncMode);
        syncMode();
        mode.connect('notify::selected', () => {
            if (PANEL_MODES[mode.selected] !== settings.get_string('panel-mode'))
                settings.set_string('panel-mode', PANEL_MODES[mode.selected]);
        });
        visibility.add(mode);

        const overview = new Adw.SwitchRow({title: _('Show in the overview')});
        settings.bind('panel-show-in-overview', overview, 'active', Gio.SettingsBindFlags.DEFAULT);
        visibility.add(overview);
        const pressure = new Adw.SwitchRow({
            title: _('Show when the pointer pushes the top edge'),
            subtitle: _('It hides again after the pointer leaves, with the delay set on the Behavior page'),
        });
        settings.bind('panel-reveal-on-pressure', pressure, 'active', Gio.SettingsBindFlags.DEFAULT);
        visibility.add(pressure);
        page.add(visibility);

        const conditions = new Adw.PreferencesGroup({
            title: _('Hide automatically when'),
            description: _('Any of the checked situations hides the top bar.'),
        });
        const conditionTitles = panelConditionTitles();
        for (const condition of PANEL_CONDITIONS) {
            const [title, subtitle] = conditionTitles[condition];
            const row = new Adw.SwitchRow({title, subtitle});
            const sync = () => {
                row.active = settings.get_strv('panel-hide-when').includes(condition);
            };
            settings.connect('changed::panel-hide-when', sync);
            sync();
            row.connect('notify::active', () => {
                const current = settings.get_strv('panel-hide-when');
                if (current.includes(condition) === row.active)
                    return;
                settings.set_strv('panel-hide-when', row.active
                    ? [...current, condition]
                    : current.filter(other => other !== condition));
            });
            conditions.add(row);
        }
        page.add(conditions);

        const syncSensitive = () => {
            const current = settings.get_string('panel-mode');
            overview.sensitive = pressure.sensitive = current !== 'always';
            conditions.sensitive = current === 'auto';
        };
        settings.connect('changed::panel-mode', syncSensitive);
        syncSensitive();

        const shortcut = new Adw.PreferencesGroup({title: _('Shortcut')});
        shortcut.add(new ShortcutRow(settings, 'panel-shortcut', _('Show or hide the top bar'),
            _('Works in every mode; press again to return to the mode above')));
        page.add(shortcut);
        return page;
    }
}
